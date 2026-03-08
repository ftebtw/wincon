import "dotenv/config";

import { desc, eq } from "drizzle-orm";

import { cachedRiotAPI } from "../src/lib/cache";
import { db, schema } from "../src/lib/db";
import { gameStateEncoder } from "../src/lib/game-state-encoder";
import type { MatchDto } from "../src/lib/types/riot";

const PLATFORM_TO_REGION: Record<string, string> = {
  na1: "americas",
  br1: "americas",
  la1: "americas",
  la2: "americas",
  oc1: "americas",
  euw1: "europe",
  eun1: "europe",
  tr1: "europe",
  ru: "europe",
  kr: "asia",
  jp1: "asia",
  ph2: "sea",
  sg2: "sea",
  th2: "sea",
  tw2: "sea",
  vn2: "sea",
};

function inferRegionFromMatchId(matchId: string): string {
  const platform = matchId.split("_")[0]?.toLowerCase() ?? "";
  return PLATFORM_TO_REGION[platform] ?? "americas";
}

function parsePatchFromGameVersion(gameVersion: string): string {
  const [major, minor] = gameVersion.split(".");
  if (!major || !minor) {
    return gameVersion;
  }

  return `${major}.${minor}`;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  const limitArg = Number(process.argv[2] ?? 200);
  const limit = Number.isFinite(limitArg) ? Math.max(1, Math.min(limitArg, 5000)) : 200;

  console.log(`[seed-vectors] Loading up to ${limit} matches from DB...`);
  const rows = await db
    .select({
      matchId: schema.matches.matchId,
      gameVersion: schema.matches.gameVersion,
      rawData: schema.matches.rawData,
      fetchedAt: schema.matches.fetchedAt,
    })
    .from(schema.matches)
    .orderBy(desc(schema.matches.fetchedAt))
    .limit(limit);

  let processed = 0;
  let failed = 0;
  let inserted = 0;

  for (const row of rows) {
    try {
      const match = row.rawData as MatchDto;
      const region = inferRegionFromMatchId(row.matchId);
      const timeline = await cachedRiotAPI.getMatchTimeline(row.matchId, region, "low");
      const patch = parsePatchFromGameVersion(row.gameVersion);

      const vectorRows = match.info.participants.flatMap((participant) => {
        const vectors = gameStateEncoder.encodeAllKeyMoments(
          match,
          timeline,
          participant.puuid,
        );

        return vectors.map((vector) => ({
          matchId: row.matchId,
          minute: vector.metadata.minute,
          playerPuuid: participant.puuid,
          championId: participant.championId,
          championName: participant.championName,
          role: vector.metadata.playerRole,
          rank: "UNKNOWN",
          isProGame: false,
          playerName: participant.riotIdGameName ?? participant.summonerName,
          teamName: null,
          patch,
          features: vector.features,
          outcome: vector.outcome,
        }));
      });

      await db
        .delete(schema.gameStateVectors)
        .where(eq(schema.gameStateVectors.matchId, row.matchId));

      if (vectorRows.length > 0) {
        await db.insert(schema.gameStateVectors).values(vectorRows);
      }

      inserted += vectorRows.length;
      processed += 1;
      console.log(`[seed-vectors] ${processed}/${rows.length} ${row.matchId} -> ${vectorRows.length} vectors`);
    } catch (error) {
      failed += 1;
      console.error(`[seed-vectors] Failed for ${row.matchId}:`, error);
    }
  }

  console.log(`[seed-vectors] complete. processed=${processed} failed=${failed} inserted=${inserted}`);
}

void main().catch((error) => {
  console.error("[seed-vectors] fatal error:", error);
  process.exit(1);
});
