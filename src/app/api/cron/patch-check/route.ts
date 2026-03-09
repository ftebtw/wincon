import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { patchTracker } from "@/lib/patch-tracker";

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
        error: "DATABASE_URL is required for patch checks.",
      },
      { status: 500 },
    );
  }

  const inserted = await db
    .insert(schema.collectionJobs)
    .values({
      jobType: "patch_check",
      status: "running",
      startedAt: new Date(),
    })
    .returning({ id: schema.collectionJobs.id });

  const jobId = inserted[0]?.id ?? null;

  try {
    const { isNew, version, previousVersion } = await patchTracker.detectNewPatch();

    if (isNew) {
      logger.info("New patch detected.", {
        endpoint: "/api/cron/patch-check",
        previousVersion,
        version,
      });

      const patchInfo = await patchTracker.fetchPatchNotes(version);

      await db
        .insert(schema.patchNotes)
        .values({
          version: patchInfo.version,
          releaseDate: new Date(patchInfo.releaseDate),
          changes: patchInfo.changes,
          rawNotesUrl: patchInfo.rawNotesUrl,
          parsedAt: new Date(patchInfo.parsedAt),
        })
        .onConflictDoUpdate({
          target: schema.patchNotes.version,
          set: {
            releaseDate: new Date(patchInfo.releaseDate),
            changes: patchInfo.changes,
            rawNotesUrl: patchInfo.rawNotesUrl,
            parsedAt: new Date(patchInfo.parsedAt),
          },
        });

      await patchTracker.handleNewPatch(version);
      await db.update(schema.pbeDiffs).set({ isLatest: false }).where(eq(schema.pbeDiffs.isLatest, true));

      if (jobId !== null) {
        await db
          .update(schema.collectionJobs)
          .set({
            status: "completed",
            report: {
              newPatch: true,
              version,
              previousVersion,
              changes: patchInfo.changes.length,
            },
            completedAt: new Date(),
          })
          .where(eq(schema.collectionJobs.id, jobId));
      }

      return Response.json({
        newPatch: true,
        version,
        previousVersion,
        changes: patchInfo.changes.length,
      });
    }

    if (jobId !== null) {
      await db
        .update(schema.collectionJobs)
        .set({
          status: "completed",
          report: {
            newPatch: false,
            currentVersion: version,
          },
          completedAt: new Date(),
        })
        .where(eq(schema.collectionJobs.id, jobId));
    }

    return Response.json({
      newPatch: false,
      currentVersion: version,
    });
  } catch (error) {
    logger.error("Patch check cron failed.", {
      endpoint: "/api/cron/patch-check",
      error: error instanceof Error ? error.message : String(error),
    });

    if (jobId !== null) {
      await db
        .update(schema.collectionJobs)
        .set({
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown patch-check failure.",
          completedAt: new Date(),
        })
        .where(eq(schema.collectionJobs.id, jobId));
    }

    return Response.json(
      {
        error: "Patch check failed.",
      },
      { status: 500 },
    );
  }
}
