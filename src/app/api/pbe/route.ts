import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return Response.json({ hasPBEChanges: false });
  }

  const latestDiff = await db
    .select()
    .from(schema.pbeDiffs)
    .where(eq(schema.pbeDiffs.isLatest, true))
    .limit(1);

  if (!latestDiff[0]) {
    return Response.json({ hasPBEChanges: false });
  }

  return Response.json({
    hasPBEChanges: true,
    liveVersion: latestDiff[0].liveVersion,
    pbeVersion: latestDiff[0].pbeVersion,
    detectedAt: latestDiff[0].detectedAt,
    totalChanges: latestDiff[0].totalChanges,
    diff: latestDiff[0].diffReport,
    aiAnalysis: latestDiff[0].aiAnalysis,
  });
}
