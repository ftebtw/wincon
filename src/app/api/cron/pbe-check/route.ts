import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { PBEDiffReport } from "@/lib/pbe-diff-engine";
import { pbeDiffEngine } from "@/lib/pbe-diff-engine";

function isAuthorized(request: Request): boolean {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    return false;
  }

  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${expectedSecret}`;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${key}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function reportFingerprint(diff: PBEDiffReport): string {
  return stableStringify({
    liveVersion: diff.liveVersion,
    pbeVersion: diff.pbeVersion,
    totalChanges: diff.totalChanges,
    championChanges: diff.championChanges.map((change) => change.humanReadable),
    itemChanges: diff.itemChanges.map((change) => change.humanReadable),
  });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!process.env.DATABASE_URL) {
    return Response.json(
      {
        error: "DATABASE_URL is required for pbe checks.",
      },
      { status: 500 },
    );
  }

  const inserted = await db
    .insert(schema.collectionJobs)
    .values({
      jobType: "pbe_check",
      status: "running",
      startedAt: new Date(),
    })
    .returning({ id: schema.collectionJobs.id });

  const jobId = inserted[0]?.id ?? null;

  try {
    const diff = await pbeDiffEngine.computeDiff();
    if (diff.totalChanges === 0) {
      if (jobId !== null) {
        await db
          .update(schema.collectionJobs)
          .set({
            status: "completed",
            report: { changes: false, message: "No PBE changes detected." },
            completedAt: new Date(),
          })
          .where(eq(schema.collectionJobs.id, jobId));
      }
      return Response.json({ changes: false, message: "No PBE changes detected" });
    }

    const lastDiffRows = await db
      .select()
      .from(schema.pbeDiffs)
      .where(eq(schema.pbeDiffs.isLatest, true))
      .limit(1);

    const last = lastDiffRows[0];
    const isNewDiff =
      !last ||
      reportFingerprint(last.diffReport as PBEDiffReport) !== reportFingerprint(diff);

    if (isNewDiff) {
      await db
        .update(schema.pbeDiffs)
        .set({ isLatest: false })
        .where(eq(schema.pbeDiffs.isLatest, true));

      const aiAnalysis = await pbeDiffEngine.generateImpactAnalysis(diff);
      diff.aiAnalysis = aiAnalysis;

      await db.insert(schema.pbeDiffs).values({
        liveVersion: diff.liveVersion,
        pbeVersion: diff.pbeVersion,
        diffReport: diff,
        aiAnalysis,
        totalChanges: diff.totalChanges,
        isLatest: true,
        detectedAt: new Date(diff.detectedAt),
      });
    }

    if (jobId !== null) {
      await db
        .update(schema.collectionJobs)
        .set({
          status: "completed",
          report: {
            changes: true,
            totalChanges: diff.totalChanges,
            championChanges: diff.championChanges.length,
            itemChanges: diff.itemChanges.length,
            isNew: isNewDiff,
          },
          completedAt: new Date(),
        })
        .where(eq(schema.collectionJobs.id, jobId));
    }

    return Response.json({
      changes: true,
      totalChanges: diff.totalChanges,
      championChanges: diff.championChanges.length,
      itemChanges: diff.itemChanges.length,
      isNew: isNewDiff,
    });
  } catch (error) {
    if (jobId !== null) {
      await db
        .update(schema.collectionJobs)
        .set({
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown pbe-check failure.",
          completedAt: new Date(),
        })
        .where(and(eq(schema.collectionJobs.id, jobId), eq(schema.collectionJobs.jobType, "pbe_check")));
    }

    logger.error("PBE check cron failed.", {
      endpoint: "/api/cron/pbe-check",
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "PBE check failed." }, { status: 500 });
  }
}
