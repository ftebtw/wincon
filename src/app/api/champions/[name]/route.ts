import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, schema } from "@/lib/db";
import { matchupGuideService } from "@/lib/matchup-guide";
import { opggClient } from "@/lib/opgg-mcp";
import { patchTracker } from "@/lib/patch-tracker";

type ChampionRouteContext = {
  params: Promise<{
    name: string;
  }>;
};

function normalizeRole(role: string): string {
  const normalized = role.toUpperCase();
  if (normalized === "MIDDLE") return "MID";
  if (normalized === "UTILITY") return "SUPPORT";
  if (normalized === "BOTTOM") return "ADC";
  return normalized;
}

function pickPrimaryRole(
  positions: Array<{ position: string; winRate: number; pickRate: number }>,
): string {
  if (positions.length === 0) {
    return "MID";
  }
  return [...positions].sort((a, b) => b.pickRate - a.pickRate)[0]?.position ?? "MID";
}

export async function GET(request: Request, { params }: ChampionRouteContext) {
  const { name } = await params;
  const championName = decodeURIComponent(name);
  const { searchParams } = new URL(request.url);
  const requestedRole = searchParams.get("role")?.trim();

  try {
    const positionsResponse = await opggClient.getChampionPositions(championName);
    const selectedRole = normalizeRole(
      requestedRole ? requestedRole : pickPrimaryRole(positionsResponse.positions),
    );

    const [meta, analysis, matchupGuides] = await Promise.all([
      opggClient.getChampionMeta(championName, selectedRole),
      opggClient.getChampionAnalysis(championName, selectedRole),
      process.env.DATABASE_URL
        ? matchupGuideService.getChampionMatchups(championName, selectedRole).catch(() => [])
        : Promise.resolve([]),
    ]);

    return NextResponse.json({
      source: "opgg",
      champion: championName,
      role: selectedRole,
      meta,
      analysis,
      positions: positionsResponse.positions,
      matchupGuides: matchupGuides.map((guide) => ({
        id: guide.id,
        enemy: guide.enemy,
        role: guide.role,
        enemyRole: guide.enemyRole,
        difficulty: guide.difficulty,
        winRate: guide.winRate,
        sampleSize: guide.sampleSize,
      })),
    });
  } catch (error) {
    console.warn("[ChampionRoute] OP.GG detail unavailable, trying DB fallback:", error);
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "Champion data unavailable from OP.GG and local database is not configured." },
      { status: 503 },
    );
  }

  try {
    const currentPatch = await patchTracker.getCurrentPatch();
    const role = normalizeRole(requestedRole ?? "MID");
    const rows = await db
      .select({
        championId: schema.championStats.championId,
        championName: schema.championStats.championName,
        role: schema.championStats.role,
        winRate: schema.championStats.winRate,
        pickRate: schema.championStats.pickRate,
        banRate: schema.championStats.banRate,
      })
      .from(schema.championStats)
      .where(
        and(
          eq(schema.championStats.patch, currentPatch),
          eq(schema.championStats.championName, championName),
          eq(schema.championStats.role, role),
          eq(schema.championStats.isStale, false),
        ),
      )
      .orderBy(desc(schema.championStats.computedAt))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Champion detail data is not available yet." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      source: "wincon",
      champion: championName,
      role,
      meta: {
        championName: rows[0].championName,
        role: rows[0].role,
        winRate: Number(rows[0].winRate ?? 0),
        pickRate: Number(rows[0].pickRate ?? 0),
        banRate: Number(rows[0].banRate ?? 0),
        tier: "3",
        sampleSize: 0,
      },
      analysis: null,
      positions: [],
      matchupGuides: [],
    });
  } catch (error) {
    console.error("[ChampionRoute] Fallback query failed:", error);
    return NextResponse.json(
      { error: "Failed to load champion detail." },
      { status: 500 },
    );
  }
}
