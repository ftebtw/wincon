import { and, eq, gte, or } from "drizzle-orm";

import { db, schema } from "@/lib/db";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type ConversionSample = {
  teamName: string;
  gameId: string;
  won: boolean;
  goldDiff10: number;
  goldDiff15: number;
};

export class GoldConversionModel {
  async getConversionRate(
    teamName: string,
    goldLead: number,
    gameTime: number,
  ): Promise<{
    teamSpecificWinProb: number;
    genericWinProb: number;
    delta: number;
    sampleSize: number;
  }> {
    const samples = await this.loadSamples(teamName);
    if (samples.length === 0) {
      const genericFallback = this.genericCurve(goldLead, gameTime);
      return {
        teamSpecificWinProb: genericFallback,
        genericWinProb: genericFallback,
        delta: 0,
        sampleSize: 0,
      };
    }

    const metric = gameTime <= 12 ? "goldDiff10" : "goldDiff15";
    const target = clamp(goldLead, -10000, 10000);

    const neighborhood = samples.filter((sample) => {
      const value = metric === "goldDiff10" ? sample.goldDiff10 : sample.goldDiff15;
      return Math.abs(value - target) <= 2200;
    });

    const teamSpecific = neighborhood.length
      ? neighborhood.filter((sample) => sample.won).length / neighborhood.length
      : this.genericCurve(goldLead, gameTime);

    const generic = this.genericCurve(goldLead, gameTime);

    return {
      teamSpecificWinProb: clamp(teamSpecific, 0.05, 0.95),
      genericWinProb: clamp(generic, 0.05, 0.95),
      delta: clamp(teamSpecific - generic, -0.2, 0.2),
      sampleSize: neighborhood.length,
    };
  }

  async getTeamRatings(
    team1: string,
    team2: string,
  ): Promise<{
    team1CloserRating: number;
    team2CloserRating: number;
    delta: number;
  }> {
    const [team1Lead, team2Lead] = await Promise.all([
      this.getConversionRate(team1, 3000, 20),
      this.getConversionRate(team2, 3000, 20),
    ]);

    return {
      team1CloserRating: team1Lead.teamSpecificWinProb,
      team2CloserRating: team2Lead.teamSpecificWinProb,
      delta: clamp(team1Lead.teamSpecificWinProb - team2Lead.teamSpecificWinProb, -0.25, 0.25),
    };
  }

  private async loadSamples(teamName: string): Promise<ConversionSample[]> {
    const rows = await db
      .select({
        gameId: schema.proPlayerStats.gameId,
        teamName: schema.proPlayerStats.teamName,
        result: schema.proPlayerStats.result,
        goldDiffAt10: schema.proPlayerStats.goldDiffAt10,
        goldDiffAt15: schema.proPlayerStats.goldDiffAt15,
      })
      .from(schema.proPlayerStats)
      .where(
        and(
          eq(schema.proPlayerStats.teamName, teamName),
          or(gte(schema.proPlayerStats.goldDiffAt10, -20000), gte(schema.proPlayerStats.goldDiffAt15, -20000)),
        ),
      )
      .limit(4000);

    const byGame = new Map<string, ConversionSample>();
    for (const row of rows) {
      const gameId = row.gameId ?? "";
      if (!gameId) {
        continue;
      }

      const existing = byGame.get(gameId) ?? {
        teamName: row.teamName,
        gameId,
        won: row.result,
        goldDiff10: 0,
        goldDiff15: 0,
      };
      existing.goldDiff10 += row.goldDiffAt10 ?? 0;
      existing.goldDiff15 += row.goldDiffAt15 ?? 0;
      existing.won = row.result;
      byGame.set(gameId, existing);
    }

    return [...byGame.values()];
  }

  private genericCurve(goldLead: number, gameTime: number): number {
    const timeWeight = gameTime <= 12 ? 1.15 : gameTime <= 20 ? 1 : 0.85;
    const scaled = clamp((goldLead / 4500) * timeWeight, -2.4, 2.4);
    return 1 / (1 + Math.exp(-scaled));
  }
}

export const goldConversionModel = new GoldConversionModel();

