import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ProDataImporter } from "@/lib/pro-data-importer";

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
        error: "DATABASE_URL is required for pro data import.",
      },
      { status: 500 },
    );
  }

  const currentYear = new Date().getFullYear();
  const importer = new ProDataImporter();

  const inserted = await db
    .insert(schema.collectionJobs)
    .values({
      jobType: "import_pro_data",
      status: "running",
      config: {
        year: currentYear,
      },
      startedAt: new Date(),
    })
    .returning({ id: schema.collectionJobs.id });
  const jobId = inserted[0]?.id ?? null;

  try {
    const csv = await importer.downloadCSV(currentYear);
    const report = await importer.parseAndImport(csv);
    await importer.computeTeamStats();

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
    logger.error("Pro data import cron failed.", {
      endpoint: "/api/cron/import-pro-data",
      error: error instanceof Error ? error.message : String(error),
    });

    if (jobId !== null) {
      await db
        .update(schema.collectionJobs)
        .set({
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown pro import error.",
          completedAt: new Date(),
        })
        .where(eq(schema.collectionJobs.id, jobId));
    }

    return Response.json(
      {
        error: "Failed to import pro data.",
      },
      { status: 500 },
    );
  }
}
