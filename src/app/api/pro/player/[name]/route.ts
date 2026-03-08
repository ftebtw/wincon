import { desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, schema } from "@/lib/db";
import { getProBuildsForChampion } from "@/lib/pro-insights";

type PlayerRouteContext = {
  params: Promise<{
    name: string;
  }>;
};

type ProMatchRow = typeof schema.proMatches.$inferSelect;

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(_request: Request, { params }: PlayerRouteContext) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "DATABASE_URL is required." }, { status: 500 });
  }

  const { name } = await params;
  const playerName = decodeURIComponent(name);

  const [playerProfile] = await db
    .select()
    .from(schema.proPlayers)
    .where(eq(schema.proPlayers.playerName, playerName))
    .orderBy(desc(schema.proPlayers.lastUpdated))
    .limit(1);

  const statsRows = await db
    .select({
      id: schema.proPlayerStats.id,
      gameId: schema.proPlayerStats.gameId,
      teamName: schema.proPlayerStats.teamName,
      champion: schema.proPlayerStats.champion,
      position: schema.proPlayerStats.position,
      result: schema.proPlayerStats.result,
      kills: schema.proPlayerStats.kills,
      deaths: schema.proPlayerStats.deaths,
      assists: schema.proPlayerStats.assists,
      cspm: schema.proPlayerStats.cspm,
      dpm: schema.proPlayerStats.dpm,
      goldShare: schema.proPlayerStats.goldShare,
      damageShare: schema.proPlayerStats.damageShare,
      visionScore: schema.proPlayerStats.visionScore,
      csAt10: schema.proPlayerStats.csAt10,
      goldAt10: schema.proPlayerStats.goldAt10,
      goldDiffAt10: schema.proPlayerStats.goldDiffAt10,
      items: schema.proPlayerStats.items,
    })
    .from(schema.proPlayerStats)
    .where(
      eq(schema.proPlayerStats.playerName, playerName),
    )
    .orderBy(desc(schema.proPlayerStats.id))
    .limit(400);

  const filtered = statsRows.filter((row) => row.position !== "TEAM");

  if (filtered.length === 0) {
    return NextResponse.json({ error: "Player not found." }, { status: 404 });
  }

  const games = filtered.length;
  const wins = filtered.filter((row) => row.result).length;

  const kills = filtered.reduce((sum, row) => sum + (row.kills ?? 0), 0);
  const deaths = filtered.reduce((sum, row) => sum + (row.deaths ?? 0), 0);
  const assists = filtered.reduce((sum, row) => sum + (row.assists ?? 0), 0);
  const avgCspm = filtered.reduce((sum, row) => sum + toNumber(row.cspm), 0) / games;
  const avgDpm = filtered.reduce((sum, row) => sum + toNumber(row.dpm), 0) / games;
  const avgGoldShare = filtered.reduce((sum, row) => sum + toNumber(row.goldShare), 0) / games;
  const avgDamageShare = filtered.reduce((sum, row) => sum + toNumber(row.damageShare), 0) / games;
  const avgVision = filtered.reduce((sum, row) => sum + toNumber(row.visionScore), 0) / games;
  const avgCsAt10 = filtered.reduce((sum, row) => sum + toNumber(row.csAt10), 0) / games;
  const avgGoldAt10 = filtered.reduce((sum, row) => sum + toNumber(row.goldAt10), 0) / games;
  const avgGoldDiffAt10 = filtered.reduce((sum, row) => sum + toNumber(row.goldDiffAt10), 0) / games;

  const championMap = new Map<string, { champion: string; games: number; wins: number; kills: number; deaths: number; assists: number }>();
  for (const row of filtered) {
    const entry = championMap.get(row.champion) ?? {
      champion: row.champion,
      games: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
    };

    entry.games += 1;
    entry.wins += row.result ? 1 : 0;
    entry.kills += row.kills ?? 0;
    entry.deaths += row.deaths ?? 0;
    entry.assists += row.assists ?? 0;

    championMap.set(row.champion, entry);
  }

  const championPool = Array.from(championMap.values())
    .map((entry) => {
      const kda = entry.deaths === 0 ? entry.kills + entry.assists : (entry.kills + entry.assists) / entry.deaths;
      return {
        champion: entry.champion,
        games: entry.games,
        wins: entry.wins,
        winRate: entry.games > 0 ? entry.wins / entry.games : 0,
        kda: Number(kda.toFixed(2)),
      };
    })
    .sort((a, b) => b.games - a.games);

  const topChampions = championPool.slice(0, 5);
  const position = playerProfile?.position ?? filtered[0].position;

  const buildsByChampion = await Promise.all(
    topChampions.map(async (entry) => {
      const builds = await getProBuildsForChampion({
        champion: entry.champion,
        role: position,
        recentGames: 200,
      });

      return {
        champion: entry.champion,
        builds: builds.slice(0, 3),
      };
    }),
  );

  const recentGameIds = filtered
    .map((row) => row.gameId)
    .filter((gameId): gameId is string => typeof gameId === "string")
    .slice(0, 30);

  const uniqueMatchIds = Array.from(new Set(recentGameIds));
  const recentMatchesMap = new Map<string, ProMatchRow>();

  if (uniqueMatchIds.length > 0) {
    const matches = await db
      .select()
      .from(schema.proMatches)
      .where(inArray(schema.proMatches.gameId, uniqueMatchIds));

    for (const match of matches) {
      recentMatchesMap.set(match.gameId, match);
    }
  }

  const recentGames = filtered.slice(0, 20).map((row) => {
    const match = row.gameId ? recentMatchesMap.get(row.gameId) : undefined;
    return {
      gameId: row.gameId,
      champion: row.champion,
      result: row.result,
      kda: `${row.kills ?? 0}/${row.deaths ?? 0}/${row.assists ?? 0}`,
      cspm: toNumber(row.cspm),
      date: match?.date ?? null,
      league: match?.league ?? null,
      patch: match?.patch ?? null,
      teamName: row.teamName,
    };
  });

  const positionRows = await db
    .select({
      cspm: schema.proPlayerStats.cspm,
      goldAt10: schema.proPlayerStats.goldAt10,
      csAt10: schema.proPlayerStats.csAt10,
      goldDiffAt10: schema.proPlayerStats.goldDiffAt10,
    })
    .from(schema.proPlayerStats)
    .where(eq(schema.proPlayerStats.position, position));

  const positionFiltered = positionRows.filter((row) => Number.isFinite(toNumber(row.cspm)));
  const positionAverages = {
    cspm:
      positionFiltered.length > 0
        ? positionFiltered.reduce((sum, row) => sum + toNumber(row.cspm), 0) / positionFiltered.length
        : 0,
    csAt10:
      positionFiltered.length > 0
        ? positionFiltered.reduce((sum, row) => sum + toNumber(row.csAt10), 0) / positionFiltered.length
        : 0,
    goldAt10:
      positionFiltered.length > 0
        ? positionFiltered.reduce((sum, row) => sum + toNumber(row.goldAt10), 0) / positionFiltered.length
        : 0,
    goldDiffAt10:
      positionFiltered.length > 0
        ? positionFiltered.reduce((sum, row) => sum + toNumber(row.goldDiffAt10), 0) / positionFiltered.length
        : 0,
  };

  return NextResponse.json({
    player: {
      playerName,
      position,
      teamId: playerProfile?.teamId ?? null,
      league: playerProfile?.league ?? null,
    },
    seasonStats: {
      games,
      wins,
      losses: games - wins,
      winRate: games > 0 ? wins / games : 0,
      kda: deaths === 0 ? kills + assists : (kills + assists) / deaths,
      cspm: avgCspm,
      dpm: avgDpm,
      goldShare: avgGoldShare,
      damageShare: avgDamageShare,
      vision: avgVision,
      csAt10: avgCsAt10,
      goldAt10: avgGoldAt10,
      goldDiffAt10: avgGoldDiffAt10,
    },
    championPool,
    buildsByChampion,
    recentGames,
    positionAverages,
  });
}
