import { and, desc, eq, inArray } from "drizzle-orm";

import { classifyTeamComp, type CompTag } from "@/lib/comp-classifier";
import { db, schema } from "@/lib/db";

type TeamCompSnapshot = {
  gameId: string;
  teamName: string;
  champions: string[];
  won: boolean;
  playedAt: Date | null;
};

export interface CompArchetype {
  tags: CompTag[];
  description: string;
}

function normalizedTagSet(tags: CompTag[]): Set<CompTag> {
  return new Set(tags);
}

function matchesArchetype(candidateTags: CompTag[], requiredTags: CompTag[]): boolean {
  const set = normalizedTagSet(candidateTags);
  return requiredTags.every((tag) => set.has(tag));
}

function normalizeDate(value: Date | string | null | undefined): string {
  if (!value) {
    return "unknown";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toISOString();
}

export class CompHistoryAnalyzer {
  private async loadRecentTeamComps(params?: {
    league?: string;
    patch?: string;
    limit?: number;
  }): Promise<TeamCompSnapshot[]> {
    const limit = params?.limit ?? 600;

    const matchRows = await db
      .select({
        gameId: schema.proMatches.gameId,
        date: schema.proMatches.date,
      })
      .from(schema.proMatches)
      .where(
        and(
          params?.league ? eq(schema.proMatches.league, params.league) : undefined,
          params?.patch ? eq(schema.proMatches.patch, params.patch) : undefined,
        ),
      )
      .orderBy(desc(schema.proMatches.date))
      .limit(limit);

    if (matchRows.length === 0) {
      return [];
    }

    const gameIds = matchRows.map((row) => row.gameId);
    const dateByGame = new Map(matchRows.map((row) => [row.gameId, row.date]));

    const rows = await db
      .select({
        gameId: schema.proPlayerStats.gameId,
        teamName: schema.proPlayerStats.teamName,
        champion: schema.proPlayerStats.champion,
        result: schema.proPlayerStats.result,
      })
      .from(schema.proPlayerStats)
      .where(inArray(schema.proPlayerStats.gameId, gameIds));

    const grouped = new Map<string, TeamCompSnapshot>();

    for (const row of rows) {
      const gameId = row.gameId ?? "";
      if (!gameId) {
        continue;
      }

      const key = `${gameId}:${row.teamName}`;
      const existing = grouped.get(key);

      if (existing) {
        if (row.champion) {
          existing.champions.push(row.champion);
        }
        continue;
      }

      grouped.set(key, {
        gameId,
        teamName: row.teamName,
        champions: row.champion ? [row.champion] : [],
        won: Boolean(row.result),
        playedAt: dateByGame.get(gameId) ?? null,
      });
    }

    return Array.from(grouped.values()).filter((entry) => entry.champions.length >= 5);
  }

  async getCompArchetypeWinRate(
    compTags: CompTag[],
    league?: string,
    patch?: string,
  ): Promise<{ winRate: number; sampleSize: number }> {
    const snapshots = await this.loadRecentTeamComps({
      league,
      patch,
      limit: 800,
    });

    if (snapshots.length === 0) {
      return { winRate: 0.5, sampleSize: 0 };
    }

    const matching: TeamCompSnapshot[] = [];
    for (const snapshot of snapshots) {
      const analysis = await classifyTeamComp(snapshot.champions);
      if (matchesArchetype(analysis.tags, compTags)) {
        matching.push(snapshot);
      }
    }

    if (matching.length === 0) {
      return { winRate: 0.5, sampleSize: 0 };
    }

    const wins = matching.filter((entry) => entry.won).length;
    return {
      winRate: wins / matching.length,
      sampleSize: matching.length,
    };
  }

  async getTeamCompWinRate(
    teamName: string,
    compTags: CompTag[],
    recentGames = 80,
  ): Promise<{ winRate: number; sampleSize: number; lastPlayed: string }> {
    const snapshots = await this.loadRecentTeamComps({ limit: recentGames * 2 });

    const teamGames = snapshots
      .filter((entry) => entry.teamName === teamName)
      .slice(0, recentGames);

    if (teamGames.length === 0) {
      return {
        winRate: 0.5,
        sampleSize: 0,
        lastPlayed: "unknown",
      };
    }

    const matches: TeamCompSnapshot[] = [];
    for (const game of teamGames) {
      const analysis = await classifyTeamComp(game.champions);
      if (matchesArchetype(analysis.tags, compTags)) {
        matches.push(game);
      }
    }

    if (matches.length === 0) {
      return {
        winRate: 0.5,
        sampleSize: 0,
        lastPlayed: "unknown",
      };
    }

    const wins = matches.filter((entry) => entry.won).length;
    const mostRecent = matches
      .map((entry) => entry.playedAt)
      .filter((entry): entry is Date => entry instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return {
      winRate: wins / matches.length,
      sampleSize: matches.length,
      lastPlayed: normalizeDate(mostRecent),
    };
  }

  async getCompVsCompWinRate(
    comp1Tags: CompTag[],
    comp2Tags: CompTag[],
  ): Promise<{ comp1WinRate: number; sampleSize: number }> {
    const snapshots = await this.loadRecentTeamComps({ limit: 900 });

    if (snapshots.length === 0) {
      return { comp1WinRate: 0.5, sampleSize: 0 };
    }

    const byGame = new Map<string, TeamCompSnapshot[]>();
    for (const snapshot of snapshots) {
      const existing = byGame.get(snapshot.gameId) ?? [];
      existing.push(snapshot);
      byGame.set(snapshot.gameId, existing);
    }

    let sampleSize = 0;
    let comp1Wins = 0;

    for (const pair of byGame.values()) {
      if (pair.length < 2) {
        continue;
      }

      const a = pair[0];
      const b = pair[1];
      const aComp = await classifyTeamComp(a.champions);
      const bComp = await classifyTeamComp(b.champions);

      const aIsComp1 = matchesArchetype(aComp.tags, comp1Tags);
      const bIsComp1 = matchesArchetype(bComp.tags, comp1Tags);
      const aIsComp2 = matchesArchetype(aComp.tags, comp2Tags);
      const bIsComp2 = matchesArchetype(bComp.tags, comp2Tags);

      if (aIsComp1 && bIsComp2) {
        sampleSize += 1;
        if (a.won) {
          comp1Wins += 1;
        }
      }

      if (bIsComp1 && aIsComp2) {
        sampleSize += 1;
        if (b.won) {
          comp1Wins += 1;
        }
      }
    }

    if (sampleSize === 0) {
      return { comp1WinRate: 0.5, sampleSize: 0 };
    }

    return {
      comp1WinRate: comp1Wins / sampleSize,
      sampleSize,
    };
  }

  async isFirstTimeComp(
    teamName: string,
    champions: string[],
    toleranceGames = 3,
  ): Promise<{ isFirstTime: boolean; similarCompsPlayed: number }> {
    const normalized = [...champions]
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
      .sort();

    const rows = await db
      .select({
        gameId: schema.proPlayerStats.gameId,
        champion: schema.proPlayerStats.champion,
      })
      .from(schema.proPlayerStats)
      .where(eq(schema.proPlayerStats.teamName, teamName));

    const byGame = new Map<string, string[]>();
    for (const row of rows) {
      const gameId = row.gameId ?? "";
      if (!gameId) {
        continue;
      }
      const existing = byGame.get(gameId) ?? [];
      existing.push(row.champion.trim().toLowerCase());
      byGame.set(gameId, existing);
    }

    let similarCompsPlayed = 0;
    for (const picks of byGame.values()) {
      const sorted = picks.sort();
      const overlap = normalized.filter((champion) => sorted.includes(champion)).length;
      if (overlap >= 4) {
        similarCompsPlayed += 1;
      }
    }

    return {
      isFirstTime: similarCompsPlayed < toleranceGames,
      similarCompsPlayed,
    };
  }
}

