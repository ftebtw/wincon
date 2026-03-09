import { and, asc, gte, inArray, lte } from "drizzle-orm";

import { db, schema } from "@/lib/db";

import { oddsClient } from "./odds-api";
import { unifiedBettingModel } from "./unified-model";

export interface BacktestResult {
  totalMatches: number;
  correctPredictions: number;
  accuracy: number;
  calibration: {
    bucket: string;
    predictedProb: number;
    actualWinRate: number;
    sampleSize: number;
  }[];
  bettingSimulation: {
    initialBankroll: number;
    finalBankroll: number;
    totalBets: number;
    betsWon: number;
    roi: number;
    maxDrawdown: number;
    sharpeRatio: number;
    profitByMonth: { month: string; profit: number }[];
  };
  featureImportance: {
    feature: string;
    importance: number;
  }[];
  worstPredictions: {
    matchId: string;
    predicted: number;
    actual: "win" | "loss";
    teams: string;
    reason: string;
  }[];
}

type PredictionSnapshot = {
  predicted: number;
  actual: boolean;
  matchId: string;
  teams: string;
  league: string;
  month: string;
};

type SimulationResult =
  | {
      skipped: true;
      predicted?: number;
      actual?: boolean;
    }
  | {
      skipped: false;
      predicted: number;
      actual: boolean;
      bet:
        | null
        | {
            side: "home" | "away";
            odds: number;
            betSize: number;
            won: boolean;
            pnl: number;
            edge: number;
          };
    };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toDateRange(date: string): Date {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  return parsed;
}

export class Backtester {
  async runBacktest(params: {
    startDate: string;
    endDate: string;
    leagues: string[];
    useDraftData: boolean;
    initialBankroll: number;
    betSizing: "flat" | "kelly";
    minEdge: number;
    maxBetFraction: number;
    sampleSize?: number;
    randomize?: boolean;
  }): Promise<BacktestResult> {
    const startDate = toDateRange(params.startDate);
    const endDate = toDateRange(params.endDate);

    let matches = await db
      .select({
        matchId: schema.proMatches.gameId,
        date: schema.proMatches.date,
        league: schema.proMatches.league,
        blueTeam: schema.proMatches.blueTeam,
        redTeam: schema.proMatches.redTeam,
        winner: schema.proMatches.winner,
      })
      .from(schema.proMatches)
      .where(
        and(
          gte(schema.proMatches.date, startDate),
          lte(schema.proMatches.date, endDate),
          inArray(schema.proMatches.league, params.leagues),
        ),
      )
      .orderBy(asc(schema.proMatches.date));

    if (params.sampleSize && params.sampleSize > 0 && matches.length > params.sampleSize) {
      if (params.randomize) {
        const shuffled = [...matches];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
          const swapIndex = Math.floor(Math.random() * (index + 1));
          const temp = shuffled[index];
          shuffled[index] = shuffled[swapIndex];
          shuffled[swapIndex] = temp;
        }
        matches = shuffled.slice(0, params.sampleSize).sort(
          (a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0),
        );
      } else {
        matches = matches.slice(0, params.sampleSize);
      }
    }

    const predictions: PredictionSnapshot[] = [];

    let bankroll = params.initialBankroll;
    let peakBankroll = bankroll;
    let maxDrawdown = 0;
    let totalBets = 0;
    let betsWon = 0;

    const monthlyProfit = new Map<string, number>();

    for (const match of matches) {
      const simulated = await this.simulateMatch(
        {
          matchId: match.matchId,
          league: match.league,
          blueTeam: match.blueTeam,
          redTeam: match.redTeam,
          winner: match.winner,
          startTime: match.date ?? new Date(),
        },
        {
          betSizing: params.betSizing,
          bankroll,
          minEdge: params.minEdge,
          maxBetFraction: params.maxBetFraction,
        },
      );

      if (simulated.skipped) {
        continue;
      }

      predictions.push({
        predicted: simulated.predicted,
        actual: simulated.actual,
        matchId: match.matchId,
        teams: `${match.blueTeam} vs ${match.redTeam}`,
        league: match.league,
        month: (match.date ?? new Date()).toISOString().slice(0, 7),
      });

      if (!simulated.bet) {
        continue;
      }

      totalBets += 1;
      if (simulated.bet.won) {
        betsWon += 1;
      }

      bankroll += simulated.bet.pnl;

      const monthProfit = monthlyProfit.get(predictions[predictions.length - 1].month) ?? 0;
      monthlyProfit.set(predictions[predictions.length - 1].month, monthProfit + simulated.bet.pnl);

      if (bankroll > peakBankroll) {
        peakBankroll = bankroll;
      }

      const drawdown = peakBankroll - bankroll;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    const correctPredictions = predictions.filter((entry) => (entry.predicted >= 0.5) === entry.actual).length;
    const accuracy = predictions.length > 0 ? correctPredictions / predictions.length : 0;

    const monthlyReturns = Array.from(monthlyProfit.values()).map((value) => value / params.initialBankroll);
    const meanReturn = monthlyReturns.length
      ? monthlyReturns.reduce((sum, value) => sum + value, 0) / monthlyReturns.length
      : 0;
    const variance = monthlyReturns.length
      ? monthlyReturns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / monthlyReturns.length
      : 0;
    const stdDev = Math.sqrt(variance);

    const sharpeRatio = stdDev > 0 ? meanReturn / stdDev : 0;

    const worstPredictions = [...predictions]
      .sort((a, b) => {
        const errA = Math.abs((a.actual ? 1 : 0) - a.predicted);
        const errB = Math.abs((b.actual ? 1 : 0) - b.predicted);
        return errB - errA;
      })
      .slice(0, 10)
      .map((entry) => ({
        matchId: entry.matchId,
        predicted: entry.predicted,
        actual: entry.actual ? ("win" as const) : ("loss" as const),
        teams: entry.teams,
        reason: "Large miss: likely outlier draft or missing roster/news context.",
      }));

    const featureImportance = await this.computeFeatureImportance(
      matches.slice(0, 120),
      {
        betSizing: params.betSizing,
        bankroll: params.initialBankroll,
        minEdge: params.minEdge,
        maxBetFraction: params.maxBetFraction,
      },
      accuracy,
    );

    return {
      totalMatches: predictions.length,
      correctPredictions,
      accuracy,
      calibration: this.computeCalibration(predictions.map((entry) => ({ predicted: entry.predicted, actual: entry.actual }))),
      bettingSimulation: {
        initialBankroll: params.initialBankroll,
        finalBankroll: bankroll,
        totalBets,
        betsWon,
        roi: params.initialBankroll > 0 ? (bankroll - params.initialBankroll) / params.initialBankroll : 0,
        maxDrawdown,
        sharpeRatio,
        profitByMonth: Array.from(monthlyProfit.entries()).map(([month, profit]) => ({
          month,
          profit,
        })),
      },
      featureImportance,
      worstPredictions,
    };
  }

  private async simulateMatch(
    match: {
      matchId: string;
      league: string;
      blueTeam: string;
      redTeam: string;
      winner: string;
      startTime: Date;
    },
    config: {
      betSizing: "flat" | "kelly";
      bankroll: number;
      minEdge: number;
      maxBetFraction: number;
      disableFeatures?: string[];
    },
  ): Promise<SimulationResult> {
    const history = await oddsClient.getHistoricalOdds(match.matchId).catch(() => []);
    const preMatch = history
      .filter((entry) => new Date(entry.timestamp).getTime() < match.startTime.getTime())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    if (!preMatch) {
      return {
        skipped: true,
      };
    }

    const marketProb = oddsClient.removeVig(preMatch.currentHomeOdds, preMatch.currentAwayOdds);

    const prediction = await unifiedBettingModel.predict({
      matchId: match.matchId,
      fixtureId: match.matchId,
      team1: match.blueTeam,
      team2: match.redTeam,
      league: match.league,
      side: { team1: "blue" },
      marketProb: marketProb.home,
      event: match.league,
      disableFeatures: config.disableFeatures,
    });

    const edge = prediction.probability - marketProb.home;

    if (Math.abs(edge) < config.minEdge || !prediction.shouldBet) {
      return {
        skipped: false,
        predicted: prediction.probability,
        actual: match.winner === match.blueTeam,
        bet: null,
      };
    }

    const side: "home" | "away" = edge > 0 ? "home" : "away";
    const odds = side === "home" ? preMatch.currentHomeOdds : preMatch.currentAwayOdds;
    const implied = 1 / Math.max(odds, 1.0001);
    const ourProb = side === "home" ? prediction.probability : 1 - prediction.probability;

    const betSize = config.betSizing === "flat"
      ? Math.min(config.bankroll * config.maxBetFraction, 10)
      : this.kellyBetSize(ourProb, implied, config.bankroll, config.maxBetFraction, prediction.uncertainty);

    if (betSize <= 0) {
      return {
        skipped: false,
        predicted: prediction.probability,
        actual: match.winner === match.blueTeam,
        bet: null,
      };
    }

    const won = (side === "home" && match.winner === match.blueTeam) || (side === "away" && match.winner === match.redTeam);
    const pnl = won ? betSize * (odds - 1) : -betSize;

    return {
      skipped: false,
      predicted: prediction.probability,
      actual: match.winner === match.blueTeam,
      bet: {
        side,
        odds,
        betSize,
        won,
        pnl,
        edge,
      },
    };
  }

  private kellyBetSize(
    predictedProb: number,
    marketProb: number,
    bankroll: number,
    maxFraction: number,
    uncertainty: number,
  ): number {
    const b = (1 / marketProb) - 1;
    const p = predictedProb;
    const q = 1 - p;

    if (b <= 0) {
      return 0;
    }

    let fraction = (b * p - q) / b;
    fraction *= 0.5;
    fraction *= clamp(1 - uncertainty / 0.12, 0.25, 1);
    fraction = clamp(fraction, 0, maxFraction);

    return bankroll * fraction;
  }

  private computeCalibration(
    predictions: { predicted: number; actual: boolean }[],
  ): BacktestResult["calibration"] {
    const buckets = [
      [0.5, 0.55],
      [0.55, 0.6],
      [0.6, 0.65],
      [0.65, 0.7],
      [0.7, 0.75],
      [0.75, 0.8],
      [0.8, 1],
    ] as const;

    return buckets.map(([start, end]) => {
      const inBucket = predictions.filter((entry) => entry.predicted >= start && entry.predicted < end);
      const predictedProb = inBucket.length
        ? inBucket.reduce((sum, entry) => sum + entry.predicted, 0) / inBucket.length
        : (start + end) / 2;
      const actualWinRate = inBucket.length
        ? inBucket.filter((entry) => entry.actual).length / inBucket.length
        : 0;

      return {
        bucket: `${Math.round(start * 100)}-${Math.round(end * 100)}%`,
        predictedProb,
        actualWinRate,
        sampleSize: inBucket.length,
      };
    });
  }

  private async computeFeatureImportance(
    matches: Array<{
      matchId: string;
      date: Date | null;
      league: string;
      blueTeam: string;
      redTeam: string;
      winner: string;
    }>,
    config: {
      betSizing: "flat" | "kelly";
      bankroll: number;
      minEdge: number;
      maxBetFraction: number;
    },
    baselineAccuracy: number,
  ): Promise<BacktestResult["featureImportance"]> {
    const features = [
      "monte_carlo",
      "solo_queue_spy",
      "roster_detection",
      "line_movement",
      "patch_transition",
      "coach_fingerprint",
      "gold_conversion",
      "regional_clash",
      "order_flow",
    ];

    const rows: BacktestResult["featureImportance"] = [];

    for (const feature of features) {
      const snapshots: Array<{ predicted: number; actual: boolean }> = [];
      for (const match of matches) {
        const simulated = await this.simulateMatch(
          {
            matchId: match.matchId,
            league: match.league,
            blueTeam: match.blueTeam,
            redTeam: match.redTeam,
            winner: match.winner,
            startTime: match.date ?? new Date(),
          },
          {
            ...config,
            disableFeatures: [feature],
          },
        );

        if (simulated.skipped) {
          continue;
        }

        snapshots.push({
          predicted: simulated.predicted,
          actual: simulated.actual,
        });
      }

      const disabledAccuracy = snapshots.length > 0
        ? snapshots.filter((entry) => (entry.predicted >= 0.5) === entry.actual).length / snapshots.length
        : baselineAccuracy;

      rows.push({
        feature,
        importance: Math.max(0, baselineAccuracy - disabledAccuracy),
      });
    }

    return rows.sort((a, b) => b.importance - a.importance);
  }
}
