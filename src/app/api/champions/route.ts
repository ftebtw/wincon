import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, schema } from "@/lib/db";
import { opggClient } from "@/lib/opgg-mcp";
import { patchTracker } from "@/lib/patch-tracker";

function normalizeRole(role: string): string {
  const normalized = role.toUpperCase();
  if (normalized === "MIDDLE") return "MID";
  if (normalized === "UTILITY") return "SUPPORT";
  return normalized;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const role = searchParams.get("role")?.trim() || undefined;

  try {
    const tierList = await opggClient.getTierList(role);
    if (tierList.champions.length > 0) {
      return NextResponse.json({
        source: "opgg",
        role: role ? normalizeRole(role) : "ALL",
        champions: tierList.champions,
      });
    }
  } catch (error) {
    console.warn("[ChampionsRoute] OP.GG tier list unavailable, using DB fallback:", error);
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "Champion data unavailable from OP.GG and local database is not configured." },
      { status: 503 },
    );
  }

  try {
    const currentPatch = await patchTracker.getCurrentPatch();
    const filters = [
      eq(schema.championStats.patch, currentPatch),
      eq(schema.championStats.tier, "ALL"),
      eq(schema.championStats.isStale, false),
    ];

    if (role) {
      filters.push(eq(schema.championStats.role, normalizeRole(role)));
    }

    const rows = await db
      .select({
        championName: schema.championStats.championName,
        role: schema.championStats.role,
        winRate: schema.championStats.winRate,
        pickRate: schema.championStats.pickRate,
        banRate: schema.championStats.banRate,
      })
      .from(schema.championStats)
      .where(and(...filters))
      .orderBy(desc(schema.championStats.winRate), desc(schema.championStats.gamesPlayed))
      .limit(150);

    const champions = rows.map((row) => ({
      championName: row.championName,
      role: row.role,
      tier: "3",
      winRate: Number(row.winRate ?? 0),
      pickRate: Number(row.pickRate ?? 0),
      banRate: Number(row.banRate ?? 0),
      change: "stable" as const,
    }));

    return NextResponse.json({
      source: "wincon",
      role: role ? normalizeRole(role) : "ALL",
      champions,
    });
  } catch (error) {
    console.error("[ChampionsRoute] Failed to load fallback champion stats:", error);
    return NextResponse.json(
      { error: "Failed to load champion tier data." },
      { status: 500 },
    );
  }
}
