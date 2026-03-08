import { and, desc, eq, inArray, or } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export interface PatchDiff {
  target: string;
  changeType: "buff" | "nerf" | "adjustment" | "new" | "removed";
  percentChange?: number;
}

export interface PatchImpactAssessment {
  overallImpact: number;
  playerImpacts: {
    player: string;
    championBuffed: string[];
    championNerfed: string[];
    poolDepth: number;
    adaptability: number;
  }[];
  teamAdaptability: number;
  confidence: "low" | "medium";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

export class PatchTransitionModel {
  async assessPatchImpact(
    teamName: string,
    patchChanges: PatchDiff[],
    patchAgeDays = 0,
  ): Promise<PatchImpactAssessment> {
    const teamRow = await db
      .select({ id: schema.proTeams.id })
      .from(schema.proTeams)
      .where(eq(schema.proTeams.teamName, teamName))
      .limit(1);

    if (!teamRow[0]?.id) {
      return {
        overallImpact: 0,
        playerImpacts: [],
        teamAdaptability: 0.5,
        confidence: "low",
      };
    }

    const roster = await db
      .select({
        player: schema.proPlayers.playerName,
      })
      .from(schema.proPlayers)
      .where(eq(schema.proPlayers.teamId, teamRow[0].id))
      .limit(8);

    const buffedSet = new Set(
      patchChanges
        .filter((entry) => entry.changeType === "buff")
        .map((entry) => normalizeText(entry.target)),
    );
    const nerfedSet = new Set(
      patchChanges
        .filter((entry) => entry.changeType === "nerf")
        .map((entry) => normalizeText(entry.target)),
    );

    const playerImpacts = await Promise.all(
      roster.map(async (player) => {
        const picks = await db
          .select({ champion: schema.proPlayerStats.champion })
          .from(schema.proPlayerStats)
          .where(eq(schema.proPlayerStats.playerName, player.player))
          .orderBy(desc(schema.proPlayerStats.id))
          .limit(20);

        const unique = [...new Set(picks.map((entry) => normalizeText(entry.champion)))];
        const championBuffed = unique.filter((entry) => buffedSet.has(entry));
        const championNerfed = unique.filter((entry) => nerfedSet.has(entry));
        const poolDepth = unique.length;
        const adaptability = clamp(poolDepth / 10, 0.2, 1);

        return {
          player: player.player,
          championBuffed,
          championNerfed,
          poolDepth,
          adaptability,
        };
      }),
    );

    const teamAdaptability = await this.computeTeamAdaptability(teamName);
    const buffedWeight = playerImpacts.reduce((sum, player) => sum + player.championBuffed.length * 0.015, 0);
    const nerfedWeight = playerImpacts.reduce((sum, player) => sum + player.championNerfed.length * 0.02, 0);
    const patchVolatility = patchAgeDays <= 5 ? 1.2 : 0.6;

    const overallImpact = clamp(
      (buffedWeight - nerfedWeight) * patchVolatility + (teamAdaptability - 0.5) * 0.06,
      -0.1,
      0.1,
    );

    return {
      overallImpact,
      playerImpacts,
      teamAdaptability,
      confidence: patchAgeDays <= 7 ? "low" : "medium",
    };
  }

  async getPatchTransitionEdge(
    team1: string,
    team2: string,
    patchChanges: PatchDiff[],
    patchAgeDays = 0,
  ): Promise<{
    team1Adjustment: number;
    team2Adjustment: number;
    reason: string;
    team1Impact: PatchImpactAssessment;
    team2Impact: PatchImpactAssessment;
  }> {
    const [team1Impact, team2Impact] = await Promise.all([
      this.assessPatchImpact(team1, patchChanges, patchAgeDays),
      this.assessPatchImpact(team2, patchChanges, patchAgeDays),
    ]);

    const diff = clamp(team1Impact.overallImpact - team2Impact.overallImpact, -0.1, 0.1);
    const timeFactor = patchAgeDays <= 5 ? 1 : patchAgeDays <= 10 ? 0.6 : 0.25;
    const adjustment = clamp(diff * timeFactor, -0.05, 0.05);

    return {
      team1Adjustment: adjustment,
      team2Adjustment: -adjustment,
      reason:
        patchAgeDays <= 5
          ? "Early patch window: adaptation speed weighted heavily."
          : "Patch edge reduced as market learns the meta.",
      team1Impact,
      team2Impact,
    };
  }

  private async computeTeamAdaptability(teamName: string): Promise<number> {
    const rows = await db
      .select({
        patch: schema.proMatches.patch,
        winner: schema.proMatches.winner,
        date: schema.proMatches.date,
      })
      .from(schema.proMatches)
      .where(
        and(
          or(
            inArray(schema.proMatches.blueTeam, [teamName]),
            inArray(schema.proMatches.redTeam, [teamName]),
          ),
        ),
      )
      .orderBy(desc(schema.proMatches.date))
      .limit(200);

    if (rows.length < 15) {
      return 0.5;
    }

    const byPatch = new Map<string, { won: boolean }[]>();
    for (const row of rows) {
      const patch = row.patch ?? "unknown";
      const values = byPatch.get(patch) ?? [];
      values.push({ won: row.winner === teamName });
      byPatch.set(patch, values);
    }

    const patchScores: number[] = [];
    for (const values of byPatch.values()) {
      if (values.length < 6) {
        continue;
      }
      const first = values.slice(0, 3);
      const later = values.slice(-3);
      const firstWr = first.filter((entry) => entry.won).length / first.length;
      const laterWr = later.filter((entry) => entry.won).length / later.length;
      patchScores.push(clamp(0.5 + (firstWr - laterWr) * -0.5, 0, 1));
    }

    if (patchScores.length === 0) {
      return 0.5;
    }

    return clamp(
      patchScores.reduce((sum, value) => sum + value, 0) / patchScores.length,
      0,
      1,
    );
  }
}

export const patchTransitionModel = new PatchTransitionModel();
