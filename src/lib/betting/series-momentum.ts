import { and, desc, eq, gte, or } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export interface GameResult {
  winner: string;
  goldDiffAt15: number;
  gameDuration: number;
  wasThrow: boolean;
  wasStormp: boolean;
  endCondition: "nexus" | "surrender" | "elder_ace";
  team1Comp: string[];
  team2Comp: string[];
  wasCheeseComp: boolean;
}

export interface SeriesState {
  format: "Bo3" | "Bo5";
  score: [number, number];
  gamesPlayed: GameResult[];
  nextGameSide: { team1: "blue" | "red" };
  team1: string;
  team2: string;
  baseMatchupProb?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class SeriesMomentumModel {
  async predictNextGame(seriesState: SeriesState): Promise<{
    team1WinProbGame: number;
    adjustments: {
      factor: string;
      impact: number;
      explanation: string;
    }[];
  }> {
    let baseProbability = clamp(seriesState.baseMatchupProb ?? 0.5, 0.05, 0.95);
    const adjustments: { factor: string; impact: number; explanation: string }[] = [];

    const scoreAdj = this.scoreStateAdjustment(seriesState);
    baseProbability += scoreAdj.impact;
    adjustments.push(scoreAdj);

    const lastGame = seriesState.gamesPlayed[seriesState.gamesPlayed.length - 1];
    if (lastGame) {
      if (lastGame.wasThrow) {
        const thrownByTeam1 = lastGame.winner !== seriesState.team1;
        const impact = thrownByTeam1 ? -0.05 : 0.05;
        baseProbability += impact;
        adjustments.push({
          factor: "throw_tilt",
          impact,
          explanation: `${thrownByTeam1 ? seriesState.team1 : seriesState.team2} threw last game lead.`,
        });
      }

      if (lastGame.wasStormp) {
        const stompByTeam1 = lastGame.winner === seriesState.team1;
        const impact = stompByTeam1 ? 0.04 : -0.04;
        baseProbability += impact;
        adjustments.push({
          factor: "stomp_momentum",
          impact,
          explanation: `${lastGame.winner} stomped previous game.`,
        });
      }

      if (lastGame.wasCheeseComp && lastGame.winner === seriesState.team1) {
        baseProbability -= 0.04;
        adjustments.push({
          factor: "cheese_decay",
          impact: -0.04,
          explanation: `${seriesState.team1} likely cannot repeat niche winning draft.`,
        });
      } else if (lastGame.wasCheeseComp && lastGame.winner === seriesState.team2) {
        baseProbability += 0.04;
        adjustments.push({
          factor: "cheese_decay",
          impact: 0.04,
          explanation: `${seriesState.team2} likely cannot repeat niche winning draft.`,
        });
      }
    }

    const losingTeam =
      lastGame?.winner === seriesState.team1 ? seriesState.team2 : seriesState.team1;
    const adaptationRate = await this.getTeamAdaptationRate(losingTeam);
    const adaptationImpact =
      losingTeam === seriesState.team1
        ? (adaptationRate - 0.5) * 0.06
        : (0.5 - adaptationRate) * 0.06;
    baseProbability += adaptationImpact;
    adjustments.push({
      factor: "draft_adaptation",
      impact: adaptationImpact,
      explanation: `${losingTeam} adaptation percentile ${(adaptationRate * 100).toFixed(0)}%.`,
    });

    if (seriesState.score[0] !== seriesState.score[1]) {
      const leadingTeam =
        seriesState.score[0] > seriesState.score[1]
          ? seriesState.team1
          : seriesState.team2;
      const closer = await this.getCloserRating(leadingTeam);
      const closerImpact =
        leadingTeam === seriesState.team1
          ? (closer - 0.5) * 0.06
          : (0.5 - closer) * 0.06;
      baseProbability += closerImpact;
      adjustments.push({
        factor: "closer_rating",
        impact: closerImpact,
        explanation: `${leadingTeam} closes ${(
          closer * 100
        ).toFixed(0)}% of series when ahead.`,
      });
    }

    if (seriesState.format === "Bo5" && seriesState.gamesPlayed.length >= 3) {
      const totalGameTime = seriesState.gamesPlayed.reduce(
        (sum, game) => sum + game.gameDuration,
        0,
      );
      if (totalGameTime > 90 * 60) {
        const fatigueImpact = ((await this.getStaminaRating(seriesState.team1)) - (await this.getStaminaRating(seriesState.team2))) * 0.02;
        baseProbability += fatigueImpact;
        adjustments.push({
          factor: "fatigue",
          impact: fatigueImpact,
          explanation: `${Math.floor(totalGameTime / 60)}m played in series; stamina factor applied.`,
        });
      }
    }

    return {
      team1WinProbGame: clamp(baseProbability, 0.05, 0.95),
      adjustments,
    };
  }

  private scoreStateAdjustment(seriesState: SeriesState): {
    factor: string;
    impact: number;
    explanation: string;
  } {
    const [team1Score, team2Score] = seriesState.score;
    const diff = team1Score - team2Score;

    const impact =
      seriesState.format === "Bo3"
        ? clamp(diff * 0.06, -0.12, 0.12)
        : clamp(diff * 0.04, -0.12, 0.12);

    return {
      factor: "score_state",
      impact,
      explanation: `Series score ${team1Score}-${team2Score} (${seriesState.format}).`,
    };
  }

  async getCloserRating(teamName: string): Promise<number> {
    const seriesRows = await this.loadSeriesRows(teamName);
    if (seriesRows.length === 0) {
      return 0.5;
    }

    let aheadSeries = 0;
    let closedSeries = 0;

    for (const series of seriesRows) {
      const game1 = series.games[0];
      if (!game1) {
        continue;
      }

      const wasAhead = game1.winner === teamName;
      if (!wasAhead) {
        continue;
      }
      aheadSeries += 1;

      const finalGame = series.games[series.games.length - 1];
      if (finalGame?.winner === teamName) {
        closedSeries += 1;
      }
    }

    if (aheadSeries === 0) {
      return 0.5;
    }

    return clamp(closedSeries / aheadSeries, 0.25, 0.85);
  }

  async getTeamAdaptationRate(teamName: string): Promise<number> {
    const seriesRows = await this.loadSeriesRows(teamName);
    if (seriesRows.length === 0) {
      return 0.5;
    }

    const improvements: number[] = [];

    for (const series of seriesRows) {
      if (series.games.length < 2) {
        continue;
      }
      const game1 = series.games[0];
      if (game1.winner === teamName) {
        continue;
      }
      const game2 = series.games[1];
      const improvement = game2.winner === teamName ? 1 : 0;
      improvements.push(improvement);
    }

    if (improvements.length === 0) {
      return 0.5;
    }

    return clamp(
      improvements.reduce((sum, value) => sum + value, 0) / improvements.length,
      0.2,
      0.8,
    );
  }

  private async getStaminaRating(teamName: string): Promise<number> {
    const rows = await db
      .select({
        gameDuration: schema.proMatches.gameDuration,
        winner: schema.proMatches.winner,
      })
      .from(schema.proMatches)
      .where(
        and(
          or(
            eq(schema.proMatches.blueTeam, teamName),
            eq(schema.proMatches.redTeam, teamName),
          ),
          gte(schema.proMatches.gameDuration, 1900),
        ),
      )
      .orderBy(desc(schema.proMatches.date))
      .limit(120);

    if (rows.length === 0) {
      return 0.5;
    }

    const wins = rows.filter((row) => row.winner === teamName).length;
    return clamp(wins / rows.length, 0.25, 0.85);
  }

  private async loadSeriesRows(teamName: string): Promise<
    {
      key: string;
      games: {
        winner: string;
        gameNumber: number;
      }[];
    }[]
  > {
    const rows = await db
      .select({
        date: schema.proMatches.date,
        gameNumber: schema.proMatches.gameNumber,
        blueTeam: schema.proMatches.blueTeam,
        redTeam: schema.proMatches.redTeam,
        winner: schema.proMatches.winner,
      })
      .from(schema.proMatches)
      .where(
        and(
          or(
            eq(schema.proMatches.blueTeam, teamName),
            eq(schema.proMatches.redTeam, teamName),
          ),
          gte(schema.proMatches.gameNumber, 1),
        ),
      )
      .orderBy(desc(schema.proMatches.date))
      .limit(600);

    const bySeries = new Map<
      string,
      {
        key: string;
        games: {
          winner: string;
          gameNumber: number;
        }[];
      }
    >();

    for (const row of rows) {
      const dateKey = row.date ? new Date(row.date).toISOString().slice(0, 10) : "unknown";
      const teams = [row.blueTeam, row.redTeam].sort().join("-");
      const key = `${dateKey}:${teams}`;
      const bucket = bySeries.get(key) ?? { key, games: [] };
      bucket.games.push({
        winner: row.winner,
        gameNumber: row.gameNumber ?? 1,
      });
      bySeries.set(key, bucket);
    }

    return [...bySeries.values()].map((series) => ({
      ...series,
      games: series.games.sort((a, b) => a.gameNumber - b.gameNumber),
    }));
  }
}

export const seriesMomentumModel = new SeriesMomentumModel();
