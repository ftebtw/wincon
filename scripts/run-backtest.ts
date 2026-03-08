import { Backtester } from "../src/lib/betting/backtester";
import { db, schema } from "../src/lib/db";

async function main() {
  const backtester = new Backtester();

  const params = {
    startDate: "2024-01-01",
    endDate: "2025-12-31",
    leagues: ["LCK", "LCS", "LEC", "LPL"],
    useDraftData: true,
    initialBankroll: 500,
    betSizing: "kelly" as const,
    minEdge: 0.08,
    maxBetFraction: 0.05,
  };

  const result = await backtester.runBacktest(params);

  console.log(`Accuracy: ${(result.accuracy * 100).toFixed(1)}%`);
  console.log(`ROI: ${(result.bettingSimulation.roi * 100).toFixed(1)}%`);
  console.log(`Final Bankroll: $${result.bettingSimulation.finalBankroll.toFixed(2)}`);
  console.log(`Max Drawdown: $${result.bettingSimulation.maxDrawdown.toFixed(2)}`);
  console.log(`Sharpe Ratio: ${result.bettingSimulation.sharpeRatio.toFixed(2)}`);

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

