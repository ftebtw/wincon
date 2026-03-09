import "./load-env";

import { Backtester } from "../src/lib/betting/backtester";
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

async function main() {
  const backtester = new Backtester();

  const params = {
    startDate: getArg("startDate") ?? process.env.BACKTEST_START_DATE ?? "2024-01-01",
    endDate: getArg("endDate") ?? process.env.BACKTEST_END_DATE ?? "2025-12-31",
    leagues: (getArg("leagues") ?? process.env.BACKTEST_LEAGUES ?? "LCK,LCS,LEC,LPL")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    useDraftData: (getArg("useDraftData") ?? process.env.BACKTEST_USE_DRAFT_DATA ?? "true") !== "false",
    initialBankroll: toNumber(
      getArg("initialBankroll") ?? process.env.BACKTEST_INITIAL_BANKROLL,
      500,
    ),
    betSizing:
      (getArg("betSizing") ?? process.env.BACKTEST_BET_SIZING ?? "kelly").toLowerCase() === "flat"
        ? ("flat" as const)
        : ("kelly" as const),
    minEdge: toNumber(getArg("minEdge") ?? process.env.BACKTEST_MIN_EDGE, 0.08),
    maxBetFraction: toNumber(
      getArg("maxBetFraction") ?? process.env.BACKTEST_MAX_BET_FRACTION,
      0.05,
    ),
    sampleSize:
      toNumber(getArg("sampleSize") ?? process.env.BACKTEST_SAMPLE_SIZE, 0) || undefined,
    randomize: (getArg("randomize") ?? process.env.BACKTEST_RANDOMIZE ?? "false") === "true",
  };

  console.log("Running backtest with params:", params);
  const result = await backtester.runBacktest(params);

  console.log(`Accuracy: ${(result.accuracy * 100).toFixed(1)}%`);
  console.log(`ROI: ${(result.bettingSimulation.roi * 100).toFixed(1)}%`);
  console.log(`Final Bankroll: $${result.bettingSimulation.finalBankroll.toFixed(2)}`);
  console.log(`Max Drawdown: $${result.bettingSimulation.maxDrawdown.toFixed(2)}`);
  console.log(`Sharpe Ratio: ${result.bettingSimulation.sharpeRatio.toFixed(2)}`);
  console.log(`Total Matches Simulated: ${result.totalMatches}`);
  console.log(`Total Bets Placed: ${result.bettingSimulation.totalBets}`);

  await db.insert(schema.backtestResults).values({
    config: params,
    results: result,
    accuracy: result.accuracy.toFixed(4),
    roi: result.bettingSimulation.roi.toFixed(4),
    totalMatches: result.totalMatches,
  });

  console.log("Backtest saved.");
}

main().catch((error) => {
  console.error("Backtest failed:", error);
  process.exit(1);
});
