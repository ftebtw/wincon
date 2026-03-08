import { desc, eq } from "drizzle-orm";

import { DataCollector, getCurrentPatch } from "@/lib/data-collector";
import { db, schema } from "@/lib/db";

const COLLECT_CONFIG = {
  tiers: ["CHALLENGER", "GRANDMASTER", "MASTER"] as const,
  matchesPerPlayer: 5,
  maxTotalMatches: 500,
  onlyCurrentPatch: true,
  lookbackDays: 60,
};

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
        error: "DATABASE_URL is required for cron collection.",
      },
      { status: 500 },
    );
  }

  const currentPatch = await getCurrentPatch();
  const lastJob = await db
    .select({ report: schema.collectionJobs.report })
    .from(schema.collectionJobs)
    .where(eq(schema.collectionJobs.jobType, "high_elo_crawl"))
    .orderBy(desc(schema.collectionJobs.startedAt))
    .limit(1);

  const lastPatch =
    (lastJob[0]?.report as { patch?: string } | null | undefined)?.patch ?? null;
  const patchChanged = Boolean(lastPatch && lastPatch !== currentPatch);

  const runConfig = patchChanged
    ? {
        ...COLLECT_CONFIG,
        matchesPerPlayer: 10,
        maxTotalMatches: 1_000,
      }
    : COLLECT_CONFIG;

  let jobId: number | null = null;
  const inserted = await db
    .insert(schema.collectionJobs)
    .values({
      jobType: "high_elo_crawl",
      status: "running",
      config: {
        ...runConfig,
        patchChanged,
        currentPatch,
      },
      startedAt: new Date(),
    })
    .returning({ id: schema.collectionJobs.id });
  jobId = inserted[0]?.id ?? null;

  try {
    const collector = new DataCollector();
    const report = await collector.runCollection(runConfig);

    if (jobId !== null) {
      await db
        .update(schema.collectionJobs)
        .set({
          status: "completed",
          report: {
            ...report,
            patchChanged,
          },
          completedAt: new Date(),
        })
        .where(eq(schema.collectionJobs.id, jobId));
    }

    return Response.json(report);
  } catch (error) {
    console.error("[CronCollect] Failed:", error);

    if (jobId !== null) {
      await db
        .update(schema.collectionJobs)
        .set({
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown cron collection error.",
          completedAt: new Date(),
        })
        .where(eq(schema.collectionJobs.id, jobId));
    }

    return Response.json(
      {
        error: "Collection job failed.",
      },
      { status: 500 },
    );
  }
}
