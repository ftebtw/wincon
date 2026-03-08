import { eq } from "drizzle-orm";

import fs from "node:fs/promises";
import path from "node:path";

import seededAccounts from "../src/data/pro-accounts.json";
import { db, schema } from "../src/lib/db";

type SeedAccount = {
  proName: string;
  team: string;
  role: string;
  region: string;
  riotId?: string;
  soloQueuePuuid?: string;
};

async function main() {
  const seedMap = new Map<string, SeedAccount>(
    (seededAccounts as SeedAccount[]).map((entry) => [entry.proName.toLowerCase(), entry]),
  );

  const proPlayers = await db
    .select({
      playerName: schema.proPlayers.playerName,
      position: schema.proPlayers.position,
      league: schema.proPlayers.league,
      riotPuuid: schema.proPlayers.riotPuuid,
      teamName: schema.proTeams.teamName,
    })
    .from(schema.proPlayers)
    .leftJoin(schema.proTeams, eq(schema.proPlayers.teamId, schema.proTeams.id))
    .limit(250);

  const merged = proPlayers.map((player) => {
    const existing = seedMap.get(player.playerName.toLowerCase());
    return {
      proName: player.playerName,
      team: player.teamName ?? existing?.team ?? "UNKNOWN",
      role: player.position ?? existing?.role ?? "UNKNOWN",
      region: existing?.region ?? player.league ?? "UNKNOWN",
      riotId: existing?.riotId ?? "",
      soloQueuePuuid: player.riotPuuid ?? existing?.soloQueuePuuid ?? "",
      source: existing ? "seed+db" : "db_only",
    };
  });

  const missingRiotId = merged.filter((entry) => !entry.riotId).length;
  const missingPuuid = merged.filter((entry) => !entry.soloQueuePuuid).length;

  const outputPath = path.join(process.cwd(), "src", "data", "pro-accounts.generated.json");
  await fs.writeFile(outputPath, JSON.stringify(merged, null, 2), "utf8");

  console.log(`Generated ${merged.length} pro account rows at ${outputPath}`);
  console.log(`Missing riotId: ${missingRiotId}`);
  console.log(`Missing soloQueuePuuid: ${missingPuuid}`);
  console.log("Review and copy verified rows into src/data/pro-accounts.json");
}

main().catch((error) => {
  console.error("Failed to build pro account mapping:", error);
  process.exit(1);
});
