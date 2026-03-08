import "dotenv/config";

import { sql } from "drizzle-orm";

import { abilityDataService } from "../src/lib/ability-data";
import { db, pool } from "../src/lib/db";
import { matchupGuideService } from "../src/lib/matchup-guide";

type MatchupSeedRow = {
  champion: string;
  role: string;
  enemy: string;
  enemyRole: string;
  games: number;
};

const DEFAULT_LIMIT = 50;
const DEFAULT_DELAY_MS = 1000;

function normalizeRole(value: string): string {
  const normalized = value.toUpperCase();
  if (normalized === "MIDDLE") return "MID";
  if (normalized === "UTILITY") return "SUPPORT";
  if (normalized === "BOTTOM") return "ADC";
  return normalized;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTopMatchups(limit: number): Promise<MatchupSeedRow[]> {
  const result = await db.execute(sql`
    select
      p1.champion_name as champion,
      p1.role as role,
      p2.champion_name as enemy,
      p2.role as enemy_role,
      count(*)::int as games
    from match_participants p1
    join match_participants p2
      on p1.match_id = p2.match_id
      and p1.team_id <> p2.team_id
      and p1.role = p2.role
    where p1.role in ('TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT', 'MIDDLE', 'UTILITY', 'BOTTOM')
    group by p1.champion_name, p1.role, p2.champion_name, p2.role
    order by games desc
    limit ${Math.max(1, limit)}
  `);

  return (result.rows as Array<Record<string, unknown>>)
    .map((row) => ({
      champion: String(row.champion ?? "").trim(),
      role: normalizeRole(String(row.role ?? "").trim()),
      enemy: String(row.enemy ?? "").trim(),
      enemyRole: normalizeRole(String(row.enemy_role ?? "").trim()),
      games: toNumber(row.games),
    }))
    .filter((row) => row.champion && row.enemy && row.role && row.enemyRole && row.games > 0);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  const limit = toNumber(process.env.MATCHUP_SEED_LIMIT, DEFAULT_LIMIT);
  const delayMs = toNumber(process.env.MATCHUP_SEED_DELAY_MS, DEFAULT_DELAY_MS);

  console.log(`Seeding ${limit} matchup guides with Sonnet (target cost ~ $0.30 for top 50).`);

  await abilityDataService.fetchAllChampions();
  const matchups = await getTopMatchups(limit);
  console.log(`Loaded ${matchups.length} most-played matchups from database.`);

  let completed = 0;
  let failed = 0;

  for (const [index, matchup] of matchups.entries()) {
    const label = `${matchup.champion} ${matchup.role} vs ${matchup.enemy} ${matchup.enemyRole}`;
    console.log(`[${index + 1}/${matchups.length}] Generating ${label}...`);

    try {
      await matchupGuideService.getGuide(
        matchup.champion,
        matchup.role,
        matchup.enemy,
        matchup.enemyRole,
      );
      completed += 1;
    } catch (error) {
      failed += 1;
      console.error(`[seed-matchup-guides] Failed ${label}:`, error);
    }

    await sleep(delayMs);
  }

  console.log(
    `Finished seeding matchup guides. Completed=${completed}, Failed=${failed}, Total=${matchups.length}`,
  );
  console.log("Expected incremental cost remains low because guides are now generated on demand.");
}

main()
  .catch((error) => {
    console.error("[seed-matchup-guides] Fatal error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
