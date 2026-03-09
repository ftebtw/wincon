import { count, desc, eq, like } from "drizzle-orm";

import { getChampionTagDatasetStatus } from "@/lib/comp-classifier";
import { getCurrentPatch } from "@/lib/data-collector";
import { db, schema } from "@/lib/db";

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return Response.json(
      {
        error: "DATABASE_URL is not configured.",
      },
      { status: 500 },
    );
  }

  const [recentJobs, totalMatchesRow, currentPatch] = await Promise.all([
    db
      .select()
      .from(schema.collectionJobs)
      .orderBy(desc(schema.collectionJobs.startedAt))
      .limit(10),
    db.select({ count: count() }).from(schema.matches),
    getCurrentPatch(),
  ]);

  const [currentPatchMatchCountRow, currentPatchBuildRows, currentPatchChampionRows, staleBuildRows, staleChampionRows] = await Promise.all([
    db
      .select({ count: count() })
      .from(schema.matches)
      .where(like(schema.matches.gameVersion, `${currentPatch}.%`)),
    db
      .select({ count: count() })
      .from(schema.buildStats)
      .where(eq(schema.buildStats.patch, currentPatch)),
    db
      .select({ count: count() })
      .from(schema.championStats)
      .where(eq(schema.championStats.patch, currentPatch)),
    db
      .select({ count: count() })
      .from(schema.buildStats)
      .where(eq(schema.buildStats.isStale, true)),
    db
      .select({ count: count() })
      .from(schema.championStats)
      .where(eq(schema.championStats.isStale, true)),
  ]);
  const championTagStatus = getChampionTagDatasetStatus(currentPatch);

  return Response.json({
    totalMatches: Number(totalMatchesRow[0]?.count ?? 0),
    currentPatch,
    currentPatchMatches: Number(currentPatchMatchCountRow[0]?.count ?? 0),
    currentPatchBuildRows: Number(currentPatchBuildRows[0]?.count ?? 0),
    currentPatchChampionRows: Number(currentPatchChampionRows[0]?.count ?? 0),
    staleBuildRows: Number(staleBuildRows[0]?.count ?? 0),
    staleChampionRows: Number(staleChampionRows[0]?.count ?? 0),
    championTagDataset: championTagStatus,
    recentJobs,
  });
}
