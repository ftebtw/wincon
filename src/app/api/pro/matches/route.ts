import { and, desc, eq, or, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, schema } from "@/lib/db";

export async function GET(request: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "DATABASE_URL is required." }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const league = searchParams.get("league")?.trim();
  const team = searchParams.get("team")?.trim();
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit") ?? 10), 100));

  const teamClause = team
    ? or(
        eq(schema.proMatches.blueTeam, team),
        eq(schema.proMatches.redTeam, team),
      )
    : undefined;

  let whereClause: SQL | undefined;
  if (league && teamClause) {
    whereClause = and(eq(schema.proMatches.league, league), teamClause);
  } else if (league) {
    whereClause = eq(schema.proMatches.league, league);
  } else if (teamClause) {
    whereClause = teamClause;
  }

  const matches = await db
    .select()
    .from(schema.proMatches)
    .where(whereClause)
    .orderBy(desc(schema.proMatches.date))
    .limit(limit);

  return NextResponse.json({
    matches,
  });
}
