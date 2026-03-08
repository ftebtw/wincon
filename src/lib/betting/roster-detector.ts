import { and, desc, eq, gte } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export interface RosterChangeSignal {
  detected: boolean;
  role: string;
  starter: string | null;
  likelySub: string | null;
  starterInactive: boolean;
  academyActive: boolean;
  confidence: number;
  reason: string;
}

type PlayerActivity = {
  playerName: string;
  role: string;
  puuid: string | null;
  proGames14d: number;
  soloGames7d: number;
  lastProGameAt: Date | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class RosterChangeDetector {
  async detectPotentialSub(teamName: string): Promise<RosterChangeSignal[]> {
    const team = await db
      .select({ id: schema.proTeams.id })
      .from(schema.proTeams)
      .where(eq(schema.proTeams.teamName, teamName))
      .limit(1);

    if (!team[0]?.id) {
      return [];
    }

    const roster = await db
      .select({
        playerName: schema.proPlayers.playerName,
        role: schema.proPlayers.position,
        puuid: schema.proPlayers.riotPuuid,
      })
      .from(schema.proPlayers)
      .where(eq(schema.proPlayers.teamId, team[0].id));

    if (roster.length === 0) {
      return [];
    }

    const roles = new Map<string, typeof roster>();
    for (const player of roster) {
      const list = roles.get(player.role) ?? [];
      list.push(player);
      roles.set(player.role, list);
    }

    const signals: RosterChangeSignal[] = [];
    for (const [role, players] of roles.entries()) {
      const activity = await Promise.all(
        players.map((player) => this.getPlayerActivity(player.playerName, role, player.puuid)),
      );

      const starter = [...activity]
        .sort((a, b) => b.proGames14d - a.proGames14d || b.soloGames7d - a.soloGames7d)[0];
      const alternatives = activity.filter((entry) => entry.playerName !== starter?.playerName);
      const subCandidate = [...alternatives].sort((a, b) => b.soloGames7d - a.soloGames7d)[0];

      if (!starter) {
        continue;
      }

      const starterInactive = starter.proGames14d === 0 && starter.soloGames7d <= 1;
      const academyActive = (subCandidate?.soloGames7d ?? 0) >= 8;
      const detected = Boolean(subCandidate) && starterInactive && academyActive;

      const confidence = clamp(
        (starterInactive ? 0.35 : 0) +
          (academyActive ? 0.35 : 0) +
          clamp((subCandidate?.soloGames7d ?? 0) / 25, 0, 0.2) +
          clamp((starter.proGames14d === 0 ? 0.1 : 0), 0, 0.1),
        0,
        0.95,
      );

      signals.push({
        detected,
        role,
        starter: starter.playerName,
        likelySub: subCandidate?.playerName ?? null,
        starterInactive,
        academyActive,
        confidence,
        reason: detected
          ? `${starter.playerName} inactive in solo queue/pro games while ${subCandidate?.playerName ?? "bench player"} is highly active.`
          : "No strong substitute signal detected.",
      });
    }

    return signals.sort((a, b) => b.confidence - a.confidence);
  }

  async getRosterRiskScore(teamName: string): Promise<{ risk: number; topSignal: RosterChangeSignal | null }> {
    const signals = await this.detectPotentialSub(teamName);
    if (signals.length === 0) {
      return { risk: 0, topSignal: null };
    }

    const top = signals[0];
    const detectedPenalty = signals
      .filter((signal) => signal.detected)
      .reduce((sum, signal) => sum + signal.confidence, 0);

    const risk = clamp(detectedPenalty / Math.max(1, signals.length / 2), 0, 1);
    return {
      risk,
      topSignal: top ?? null,
    };
  }

  private async getPlayerActivity(
    playerName: string,
    role: string,
    puuid: string | null,
  ): Promise<PlayerActivity> {
    const now = Date.now();
    const cutoff14d = new Date(now - 14 * 24 * 60 * 60 * 1000);
    const cutoff7dSeconds = Math.floor(now / 1000) - 7 * 24 * 60 * 60;

    const [proRows, soloRows] = await Promise.all([
      db
        .select({ gameId: schema.proPlayerStats.gameId, matchDate: schema.proMatches.date })
        .from(schema.proPlayerStats)
        .leftJoin(
          schema.proMatches,
          eq(schema.proPlayerStats.gameId, schema.proMatches.gameId),
        )
        .where(
          and(
            eq(schema.proPlayerStats.playerName, playerName),
            eq(schema.proPlayerStats.position, role),
            gte(schema.proMatches.date, cutoff14d),
          ),
        )
        .orderBy(desc(schema.proMatches.date))
        .limit(50),
      puuid
        ? db
            .select({ matchId: schema.matchParticipants.matchId })
            .from(schema.matchParticipants)
            .innerJoin(
              schema.matches,
              eq(schema.matchParticipants.matchId, schema.matches.matchId),
            )
            .where(
              and(
                eq(schema.matchParticipants.puuid, puuid),
                gte(schema.matches.gameStartTs, cutoff7dSeconds),
              ),
            )
            .limit(80)
        : Promise.resolve([]),
    ]);

    return {
      playerName,
      role,
      puuid,
      proGames14d: proRows.length,
      soloGames7d: soloRows.length,
      lastProGameAt: proRows[0]?.matchDate ?? null,
    };
  }
}

export const rosterChangeDetector = new RosterChangeDetector();

