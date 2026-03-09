import { desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getCurrentPatch } from "@/lib/data-collector";
import { db, schema } from "@/lib/db";

function isAuthorized(request: Request): boolean {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    return false;
  }
  return request.headers.get("authorization") === `Bearer ${expectedSecret}`;
}

type HealthCheck = {
  name: string;
  ok: boolean;
  details?: string;
};

async function checkRiotReachability(): Promise<HealthCheck> {
  const key = process.env.RIOT_API_KEY;
  if (!key) {
    return {
      name: "riot_api",
      ok: false,
      details: "RIOT_API_KEY is missing.",
    };
  }

  const response = await fetch("https://na1.api.riotgames.com/lol/status/v4/platform-data", {
    headers: {
      "X-Riot-Token": key,
    },
    cache: "no-store",
  }).catch(() => null);

  if (!response) {
    return {
      name: "riot_api",
      ok: false,
      details: "Riot API request failed.",
    };
  }

  return {
    name: "riot_api",
    ok: response.ok,
    details: response.ok ? "reachable" : `status=${response.status}`,
  };
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const checks: HealthCheck[] = [];

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      {
        status: "unhealthy",
        checks: [
          {
            name: "database",
            ok: false,
            details: "DATABASE_URL is missing.",
          },
        ],
      },
      { status: 500 },
    );
  }

  try {
    await db.execute(sql`select 1`);
    checks.push({ name: "database", ok: true, details: "connected" });
  } catch (error) {
    checks.push({
      name: "database",
      ok: false,
      details: error instanceof Error ? error.message : "query failed",
    });
  }

  checks.push(await checkRiotReachability());

  try {
    const [lastCron] = await db
      .select({
        completedAt: schema.collectionJobs.completedAt,
      })
      .from(schema.collectionJobs)
      .where(eq(schema.collectionJobs.status, "completed"))
      .orderBy(desc(schema.collectionJobs.completedAt))
      .limit(1);

    const completedAt = lastCron?.completedAt ?? null;
    const ageMs = completedAt ? Date.now() - completedAt.getTime() : Number.POSITIVE_INFINITY;
    checks.push({
      name: "cron_freshness",
      ok: ageMs < 8 * 60 * 60 * 1000,
      details: completedAt
        ? `last_success=${completedAt.toISOString()}`
        : "no successful cron jobs recorded",
    });
  } catch (error) {
    checks.push({
      name: "cron_freshness",
      ok: false,
      details: error instanceof Error ? error.message : "unable to read collection jobs",
    });
  }

  try {
    const currentPatch = await getCurrentPatch();
    const [latestComputed] = await db
      .select({
        patch: schema.championStats.patch,
      })
      .from(schema.championStats)
      .orderBy(desc(schema.championStats.computedAt))
      .limit(1);

    checks.push({
      name: "patch_sync",
      ok: latestComputed?.patch === currentPatch,
      details: `current=${currentPatch}, stats=${latestComputed?.patch ?? "none"}`,
    });
  } catch (error) {
    checks.push({
      name: "patch_sync",
      ok: false,
      details: error instanceof Error ? error.message : "patch sync check failed",
    });
  }

  const okCount = checks.filter((check) => check.ok).length;
  const status =
    okCount === checks.length ? "healthy" : okCount >= 2 ? "degraded" : "unhealthy";

  return NextResponse.json({
    status,
    checks,
  });
}
