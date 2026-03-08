import { and, eq, gte } from "drizzle-orm";

import proAccountsJson from "@/data/pro-accounts.json";
import { db, schema } from "@/lib/db";

export interface ProPlayerAccount {
  proName: string;
  team: string;
  role: string;
  soloQueuePuuid?: string;
  riotId?: string;
  region: string;
}

export interface ChampionPracticeSignal {
  player: string;
  team: string;
  champion: string;
  gamesLast3Days: number;
  gamesLast30Days: number;
  winRate: number;
  isUnusual: boolean;
  confidenceScore: number;
  lastPlayed: string;
}

export interface DraftPrediction {
  team: string;
  predictedPicks: {
    role: string;
    champion: string;
    confidence: number;
    evidence: string;
  }[];
  predictedBans: {
    champion: string;
    confidence: number;
    evidence: string;
  }[];
}

type RecentSoloGame = {
  champion: string;
  win: boolean;
  timestamp: number;
};

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseRiotId(riotId: string): { gameName: string; tagLine: string } | null {
  const [gameName, tagLine] = riotId.split("#");
  if (!gameName || !tagLine) {
    return null;
  }

  return {
    gameName: gameName.trim(),
    tagLine: tagLine.trim(),
  };
}

export class SoloQueueSpy {
  private proAccounts: ProPlayerAccount[];
  private puuidCache = new Map<string, string | null>();

  constructor(accounts: ProPlayerAccount[] = proAccountsJson as ProPlayerAccount[]) {
    this.proAccounts = accounts;
  }

  async scanTeamPractice(teamName: string, daysBack = 5): Promise<ChampionPracticeSignal[]> {
    const team = normalizeText(teamName);
    const players = this.proAccounts.filter((entry) => normalizeText(entry.team) === team);
    if (players.length === 0) {
      return [];
    }

    const signals = await Promise.all(
      players.map(async (player) => {
        const puuid = await this.resolvePuuid(player);
        if (!puuid) {
          return [] as ChampionPracticeSignal[];
        }

        const [recentGames, baselineGames] = await Promise.all([
          this.getPlayerRecentGames(puuid, daysBack),
          this.getPlayerRecentGames(puuid, 30),
        ]);

        if (recentGames.length === 0 || baselineGames.length === 0) {
          return [] as ChampionPracticeSignal[];
        }

        const recentCounts = this.countChampions(recentGames);
        const baselineCounts = this.countChampions(baselineGames);
        const playerSignals: ChampionPracticeSignal[] = [];

        for (const [champion, recentCount] of recentCounts.entries()) {
          const baselineCount = baselineCounts.get(champion) ?? 0;
          const baselineRate = baselineCount / 30;
          const recentRate = recentCount / Math.max(daysBack, 1);
          const ratio = recentRate / Math.max(0.01, baselineRate);

          if (ratio < 3 || recentCount < 3) {
            continue;
          }

          const last = recentGames.find((game) => game.champion === champion);

          playerSignals.push({
            player: player.proName,
            team: player.team,
            champion,
            gamesLast3Days: recentCount,
            gamesLast30Days: baselineCount,
            winRate: this.calculateWinRate(recentGames, champion),
            isUnusual: true,
            confidenceScore: this.calculateConfidence(recentCount, baselineCount, daysBack),
            lastPlayed: last
              ? new Date(last.timestamp * 1000).toISOString()
              : new Date().toISOString(),
          });
        }

        return playerSignals;
      }),
    );

    return signals
      .flat()
      .sort((a, b) => b.confidenceScore - a.confidenceScore);
  }

  async predictDraft(teamName: string, opponent: string): Promise<DraftPrediction> {
    const [teamSignals, opponentSignals] = await Promise.all([
      this.scanTeamPractice(teamName, 5),
      this.scanTeamPractice(opponent, 5),
    ]);

    const predictedPicks = teamSignals
      .filter((signal) => signal.confidenceScore >= 0.6)
      .map((signal) => ({
        role: this.getPlayerRole(signal.player),
        champion: signal.champion,
        confidence: signal.confidenceScore,
        evidence:
          `${signal.player} spammed ${signal.champion}: ${signal.gamesLast3Days} games in ${Math.max(1, 3)} days` +
          ` (baseline ${signal.gamesLast30Days} in 30d)`,
      }))
      .slice(0, 5);

    const predictedBans = opponentSignals
      .filter((signal) => signal.confidenceScore >= 0.7)
      .map((signal) => ({
        champion: signal.champion,
        confidence: clamp(signal.confidenceScore * 0.55, 0, 0.95),
        evidence:
          `${signal.player} (${opponent}) repeatedly practiced ${signal.champion};` +
          " expected to draw ban pressure.",
      }))
      .slice(0, 5);

    return {
      team: teamName,
      predictedPicks,
      predictedBans,
    };
  }

  async scanMatchPractice(team1: string, team2: string): Promise<{
    team1: ChampionPracticeSignal[];
    team2: ChampionPracticeSignal[];
    team1Draft: DraftPrediction;
    team2Draft: DraftPrediction;
  }> {
    const [team1Signals, team2Signals, team1Draft, team2Draft] = await Promise.all([
      this.scanTeamPractice(team1),
      this.scanTeamPractice(team2),
      this.predictDraft(team1, team2),
      this.predictDraft(team2, team1),
    ]);

    return {
      team1: team1Signals,
      team2: team2Signals,
      team1Draft,
      team2Draft,
    };
  }

  private async resolvePuuid(account: ProPlayerAccount): Promise<string | null> {
    const cacheKey = `${account.team}:${account.proName}`;
    if (this.puuidCache.has(cacheKey)) {
      return this.puuidCache.get(cacheKey) ?? null;
    }

    if (account.soloQueuePuuid) {
      this.puuidCache.set(cacheKey, account.soloQueuePuuid);
      return account.soloQueuePuuid;
    }

    let foundPuuid: string | null = null;

    if (account.riotId) {
      const parsed = parseRiotId(account.riotId);
      if (parsed) {
        const players = await db
          .select({ puuid: schema.players.puuid })
          .from(schema.players)
          .where(
            and(
              eq(schema.players.gameName, parsed.gameName),
              eq(schema.players.tagLine, parsed.tagLine),
            ),
          )
          .limit(1);
        foundPuuid = players[0]?.puuid ?? null;
      }
    }

    if (!foundPuuid) {
      const proRows = await db
        .select({ puuid: schema.proPlayers.riotPuuid })
        .from(schema.proPlayers)
        .where(eq(schema.proPlayers.playerName, account.proName))
        .limit(1);
      foundPuuid = proRows[0]?.puuid ?? null;
    }

    this.puuidCache.set(cacheKey, foundPuuid);
    return foundPuuid;
  }

  private async getPlayerRecentGames(puuid: string, daysBack: number): Promise<RecentSoloGame[]> {
    const cutoffSeconds = Math.floor(Date.now() / 1000) - daysBack * 24 * 60 * 60;

    const rows = await db
      .select({
        champion: schema.matchParticipants.championName,
        win: schema.matchParticipants.win,
        gameStartTs: schema.matches.gameStartTs,
      })
      .from(schema.matchParticipants)
      .innerJoin(
        schema.matches,
        eq(schema.matchParticipants.matchId, schema.matches.matchId),
      )
      .where(
        and(
          eq(schema.matchParticipants.puuid, puuid),
          gte(schema.matches.gameStartTs, cutoffSeconds),
        ),
      )
      .limit(200);

    return rows.map((row) => ({
      champion: row.champion,
      win: row.win,
      timestamp: toNumber(row.gameStartTs, cutoffSeconds),
    }));
  }

  private countChampions(games: RecentSoloGame[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const game of games) {
      counts.set(game.champion, (counts.get(game.champion) ?? 0) + 1);
    }
    return counts;
  }

  private calculateWinRate(games: RecentSoloGame[], champion: string): number {
    const championGames = games.filter((game) => game.champion === champion);
    if (championGames.length === 0) {
      return 0.5;
    }

    const wins = championGames.filter((game) => game.win).length;
    return wins / championGames.length;
  }

  private getPlayerRole(playerName: string): string {
    const player = this.proAccounts.find(
      (entry) => normalizeText(entry.proName) === normalizeText(playerName),
    );
    return player?.role ?? "UNKNOWN";
  }

  private calculateConfidence(recentCount: number, baselineCount: number, daysBack: number): number {
    if (baselineCount === 0 && recentCount >= 3) {
      return 0.9;
    }
    if (baselineCount === 0 && recentCount >= 1) {
      return 0.6;
    }

    const baselineRate = baselineCount / 30;
    const recentRate = recentCount / Math.max(1, daysBack);
    const ratio = recentRate / Math.max(0.01, baselineRate);

    return clamp(ratio / 10, 0.2, 0.95);
  }
}

export const soloQueueSpy = new SoloQueueSpy();

