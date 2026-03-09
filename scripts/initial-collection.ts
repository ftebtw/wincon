import "./load-env";

import { DataCollector, getCurrentPatch } from "../src/lib/data-collector";
import { pool } from "../src/lib/db";

async function main() {
  if (!process.env.RIOT_API_KEY) {
    throw new Error("RIOT_API_KEY is required.");
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  const collector = new DataCollector();

  console.log("Starting initial data collection...");
  console.log("This will take 4-8 hours with a personal API key.");
  console.log("Target: ~10,000 matches from current patch, high-elo only.");

  const report = await collector.runCollection({
    tiers: ["CHALLENGER", "GRANDMASTER", "MASTER"],
    matchesPerPlayer: 20,
    maxTotalMatches: 10_000,
    onlyCurrentPatch: false,
    lookbackDays: 60,
  });

  console.log("Collection complete:", report);

  const patch = await getCurrentPatch();
  await collector.recomputeBuildStats(patch);
  await collector.recomputeChampionStats(patch);

  console.log("Stats computed for patch", patch);
}

main()
  .catch((error) => {
    console.error("[initial-collection] Failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
