import { and, eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { progressTracker } from "@/lib/progress-tracker";

function isAuthorized(request: Request): boolean {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    return false;
  }

  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${expectedSecret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!process.env.DATABASE_URL) {
    return Response.json(
      {
        error: "DATABASE_URL is required for progress snapshot computation.",
      },
      { status: 500 },
    );
  }

  const inserted = await db
    .insert(schema.collectionJobs)
    .values({
      jobType: "progress_compute",
      status: "running",
      startedAt: new Date(),
    })
    .returning({ id: schema.collectionJobs.id });

  const jobId = inserted[0]?.id ?? null;

  try {
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const activePlayers = await db
      .select({ puuid: schema.matchParticipants.puuid })
      .from(schema.matchParticipants)
      .innerJoin(schema.matches, eq(schema.matchParticipants.matchId, schema.matches.matchId))
      .where(
        and(
          eq(schema.matches.queueId, 420),
          sql`${schema.matches.gameStartTs} >= ${sevenDaysAgoMs}`,
        ),
      )
      .groupBy(schema.matchParticipants.puuid)
      .having(sql`count(*) >= 5`);

    let computed = 0;
    let failed = 0;

    for (const player of activePlayers) {
      try {
        const snapshot = await progressTracker.computeSnapshot(player.puuid, "week", 0);
        await progressTracker.cacheSnapshot(player.puuid, snapshot);
        computed += 1;
      } catch (error) {
        failed += 1;
        console.error(`[ComputeProgressCron] Failed for ${player.puuid}:`, error);
      }
    }

    const report = {
      playersActive: activePlayers.length,
      playersComputed: computed,
      playersFailed: failed,
    };

    if (jobId !== null) {
      await db
        .update(schema.collectionJobs)
        .set({
          status: "completed",
          report,
          completedAt: new Date(),
        })
        .where(eq(schema.collectionJobs.id, jobId));
    }

    return Response.json(report);
  } catch (error) {
    console.error("[ComputeProgressCron] Failed:", error);

    if (jobId !== null) {
      await db
        .update(schema.collectionJobs)
        .set({
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown progress compute error.",
          completedAt: new Date(),
        })
        .where(eq(schema.collectionJobs.id, jobId));
    }

    return Response.json(
      {
        error: "Failed to compute weekly progress snapshots.",
      },
      { status: 500 },
    );
  }
}
