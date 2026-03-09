import { gte, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, schema } from "@/lib/db";

function isAuthorized(request: Request): boolean {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    return false;
  }
  return request.headers.get("authorization") === `Bearer ${expectedSecret}`;
}

function startOfUtcDay(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "DATABASE_URL is not configured." },
      { status: 500 },
    );
  }

  const todayStart = startOfUtcDay();
  const weekStart = daysAgo(7);
  const monthStart = daysAgo(30);

  const [today, week, month, analysesByDay] = await Promise.all([
    db
      .select({
        totalCost: sql<string>`coalesce(sum(${schema.aiAnalyses.estimatedCost}), 0)`,
        totalAnalyses: sql<number>`count(*)`,
      })
      .from(schema.aiAnalyses)
      .where(gte(schema.aiAnalyses.createdAt, todayStart))
      .limit(1),
    db
      .select({
        totalCost: sql<string>`coalesce(sum(${schema.aiAnalyses.estimatedCost}), 0)`,
        totalAnalyses: sql<number>`count(*)`,
      })
      .from(schema.aiAnalyses)
      .where(gte(schema.aiAnalyses.createdAt, weekStart))
      .limit(1),
    db
      .select({
        totalCost: sql<string>`coalesce(sum(${schema.aiAnalyses.estimatedCost}), 0)`,
        totalAnalyses: sql<number>`count(*)`,
      })
      .from(schema.aiAnalyses)
      .where(gte(schema.aiAnalyses.createdAt, monthStart))
      .limit(1),
    db
      .select({
        day: sql<string>`to_char(${schema.aiAnalyses.createdAt}, 'YYYY-MM-DD')`,
        analyses: sql<number>`count(*)`,
        cost: sql<string>`coalesce(sum(${schema.aiAnalyses.estimatedCost}), 0)`,
      })
      .from(schema.aiAnalyses)
      .where(gte(schema.aiAnalyses.createdAt, monthStart))
      .groupBy(sql`to_char(${schema.aiAnalyses.createdAt}, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${schema.aiAnalyses.createdAt}, 'YYYY-MM-DD') asc`),
  ]);

  const monthCost = Number(month[0]?.totalCost ?? 0);
  const monthAnalyses = Number(month[0]?.totalAnalyses ?? 0);
  const averageCost = monthAnalyses > 0 ? monthCost / monthAnalyses : 0;

  return NextResponse.json({
    totals: {
      today: {
        cost: Number(today[0]?.totalCost ?? 0),
        analyses: Number(today[0]?.totalAnalyses ?? 0),
      },
      week: {
        cost: Number(week[0]?.totalCost ?? 0),
        analyses: Number(week[0]?.totalAnalyses ?? 0),
      },
      month: {
        cost: monthCost,
        analyses: monthAnalyses,
      },
      averageCostPerAnalysis: Number(averageCost.toFixed(6)),
    },
    chartData: analysesByDay.map((row) => ({
      day: row.day,
      analyses: Number(row.analyses ?? 0),
      cost: Number(row.cost ?? 0),
    })),
  });
}
