import { eq } from "drizzle-orm";

import { DataCollector, getCurrentPatch } from "@/lib/data-collector";
import { db, schema } from "@/lib/db";

function isAuthorized(request: Request): boolean {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    return false;
  }

  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${expectedSecret}`;
}

async function createJob(jobType: string, config: Record<string, unknown>) {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const inserted = await db
    .insert(schema.collectionJobs)
    .values({
      jobType,
      status: "running",
      config,
      startedAt: new Date(),
    })
    .returning({ id: schema.collectionJobs.id });

  return inserted[0]?.id ?? null;
}

async function completeJob(jobId: number | null, report: Record<string, unknown>) {
  if (jobId === null) {
    return;
  }

  await db
    .update(schema.collectionJobs)
    .set({
      status: "completed",
      report,
      completedAt: new Date(),
    })
    .where(eq(schema.collectionJobs.id, jobId));
}

async function failJob(jobId: number | null, error: unknown) {
  if (jobId === null) {
    return;
  }

  await db
    .update(schema.collectionJobs)
    .set({
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown compute-stats error.",
      completedAt: new Date(),
    })
    .where(eq(schema.collectionJobs.id, jobId));
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!process.env.DATABASE_URL) {
    return Response.json(
      {
        error: "DATABASE_URL is required for cron stats computation.",
      },
      { status: 500 },
    );
  }

  const patch = await getCurrentPatch();
  const collector = new DataCollector();

  const buildJobId = await createJob("build_stats", { patch });
  try {
    await collector.recomputeBuildStats(patch);
    await completeJob(buildJobId, { patch, status: "completed" });
  } catch (error) {
    await failJob(buildJobId, error);
    return Response.json({ patch, status: "failed" }, { status: 500 });
  }

  const championJobId = await createJob("champion_stats", { patch });
  try {
    await collector.recomputeChampionStats(patch);
    await completeJob(championJobId, { patch, status: "completed" });
  } catch (error) {
    await failJob(championJobId, error);
    return Response.json({ patch, status: "failed" }, { status: 500 });
  }

  return Response.json({ patch, status: "completed" });
}
