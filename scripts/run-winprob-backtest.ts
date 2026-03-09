import "./load-env";

import { and, asc, gte, inArray, lte } from "drizzle-orm";

import { PredictionModel } from "../src/lib/betting/prediction-model";
import { db, schema } from "../src/lib/db";

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const entry = process.argv.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : undefined;
}

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toDate(value: string, fallback: string): Date {
  const parsed = new Date(value || fallback);
  if (!Number.isFinite(parsed.getTime())) {
    return new Date(fallback);
  }
  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type Snapshot = {
  matchId: string;
  league: string;
  predicted: number;
  actual: boolean;
};

function calibrationBuckets(predictions: Snapshot[]) {
  const rows: Array<{
    bucket: string;
    predictedProb: number;
    actualWinRate: number;
    sampleSize: number;
  }> = [];

  for (let start = 0; start < 1; start += 0.1) {
    const end = start + 0.1;
    const inBucket = predictions.filter(
      (row) => row.predicted >= start && row.predicted < end,
    );
    const predictedProb =
      inBucket.length > 0
        ? inBucket.reduce((sum, row) => sum + row.predicted, 0) / inBucket.length
        : (start + end) / 2;
    const actualWinRate =
      inBucket.length > 0
        ? inBucket.filter((row) => row.actual).length / inBucket.length
        : 0;

    rows.push({
      bucket: `${Math.round(start * 100)}-${Math.round(end * 100)}%`,
      predictedProb,
      actualWinRate,
      sampleSize: inBucket.length,
    });
  }

  return rows;
}

async function main() {
  const params = {
    startDate: toDate(
      getArg("startDate") ?? process.env.WINPROB_START_DATE ?? "2024-01-01",
      "2024-01-01",
    ),
    endDate: toDate(
      getArg("endDate") ?? process.env.WINPROB_END_DATE ?? "2025-12-31",
      "2025-12-31",
    ),
    leagues: (
      getArg("leagues") ??
      process.env.WINPROB_LEAGUES ??
      "LCK,LCS,LEC,LPL"
    )
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    sampleSize:
      toNumber(getArg("sampleSize") ?? process.env.WINPROB_SAMPLE_SIZE, 0) ||
      undefined,
    randomize:
      (getArg("randomize") ?? process.env.WINPROB_RANDOMIZE ?? "false") ===
      "true",
  };

  console.log("Running win-probability backtest with params:", {
    ...params,
    startDate: params.startDate.toISOString().slice(0, 10),
    endDate: params.endDate.toISOString().slice(0, 10),
  });

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
        gte(schema.proMatches.date, params.startDate),
        lte(schema.proMatches.date, params.endDate),
        inArray(schema.proMatches.league, params.leagues),
      ),
    )
    .orderBy(asc(schema.proMatches.date));

  if (
    params.sampleSize &&
    params.sampleSize > 0 &&
    matches.length > params.sampleSize
  ) {
    if (params.randomize) {
      const shuffled = [...matches];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        const tmp = shuffled[index];
        shuffled[index] = shuffled[swapIndex];
        shuffled[swapIndex] = tmp;
      }
      matches = shuffled
        .slice(0, params.sampleSize)
        .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
    } else {
      matches = matches.slice(0, params.sampleSize);
    }
  }

  const model = new PredictionModel();
  const predictions: Snapshot[] = [];

  for (const match of matches) {
    const predicted = await model.predict({
      team1: match.blueTeam,
      team2: match.redTeam,
      league: match.league,
      side: { team1: "blue" },
      includeEdgeSignals: false,
      includePlayerForm: true,
    });

    predictions.push({
      matchId: match.matchId,
      league: match.league,
      predicted: clamp(predicted.team1WinProb, 0.0001, 0.9999),
      actual: match.winner === match.blueTeam,
    });
  }

  const total = predictions.length;
  const correct = predictions.filter(
    (row) => (row.predicted >= 0.5) === row.actual,
  ).length;
  const accuracy = total > 0 ? correct / total : 0;
  const brier =
    total > 0
      ? predictions.reduce((sum, row) => {
          const actual = row.actual ? 1 : 0;
          return sum + (row.predicted - actual) ** 2;
        }, 0) / total
      : 0;
  const logLoss =
    total > 0
      ? predictions.reduce((sum, row) => {
          const p = clamp(row.predicted, 1e-6, 1 - 1e-6);
          return sum + (row.actual ? -Math.log(p) : -Math.log(1 - p));
        }, 0) / total
      : 0;

  const byLeague = params.leagues.map((league) => {
    const rows = predictions.filter((row) => row.league === league);
    const leagueAccuracy =
      rows.length > 0
        ? rows.filter((row) => (row.predicted >= 0.5) === row.actual).length /
          rows.length
        : 0;
    return {
      league,
      matches: rows.length,
      accuracy: leagueAccuracy,
    };
  });

  console.log(`Total Matches: ${total}`);
  console.log(`Accuracy: ${(accuracy * 100).toFixed(2)}%`);
  console.log(`Brier Score: ${brier.toFixed(4)} (lower is better)`);
  console.log(`Log Loss: ${logLoss.toFixed(4)} (lower is better)`);
  console.log("By league:", byLeague);

  const result = {
    totalMatches: total,
    correctPredictions: correct,
    accuracy,
    brier,
    logLoss,
    calibration: calibrationBuckets(predictions),
    byLeague,
  };

  await db.insert(schema.backtestResults).values({
    config: {
      kind: "win_probability",
      ...params,
      startDate: params.startDate.toISOString(),
      endDate: params.endDate.toISOString(),
    },
    results: result,
    accuracy: accuracy.toFixed(4),
    roi: null,
    totalMatches: total,
  });

  console.log("Win-probability backtest saved.");
}

main().catch((error) => {
  console.error("Win-probability backtest failed:", error);
  process.exit(1);
});
