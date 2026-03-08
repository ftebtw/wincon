import { desc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, schema } from "@/lib/db";
import { ProMatchPredictor } from "@/lib/pro-match-predictor";

type TeamRouteContext = {
  params: Promise<{
    teamSlug: string;
  }>;
};

type PlayerAggregate = {
  playerName: string;
  position: string;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  cspm: number;
  damageShare: number;
  championCounts: Map<string, number>;
};

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function monthBucket(value: Date | null): string {
  if (!value) {
    return "Unknown";
  }

  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export async function GET(_request: Request, { params }: TeamRouteContext) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "DATABASE_URL is required." }, { status: 500 });
  }

  const { teamSlug } = await params;
  const decodedTeamSlug = decodeURIComponent(teamSlug);

  const teams = await db
    .select()
    .from(schema.proTeams)
    .where(eq(schema.proTeams.teamSlug, decodedTeamSlug))
    .limit(1);

  const team = teams[0];
  if (!team) {
    return NextResponse.json({ error: "Team not found." }, { status: 404 });
  }

  const [latestTeamStats] = await db
    .select()
    .from(schema.proTeamStats)
    .where(eq(schema.proTeamStats.teamName, team.teamName))
    .orderBy(desc(schema.proTeamStats.computedAt))
    .limit(1);

  const split = latestTeamStats?.split ?? team.split ?? "Unknown";

  const predictor = new ProMatchPredictor();
  const strengthProfile = await predictor.getTeamStrengthProfile(team.teamName, split);

  const rosterRows = await db
    .select()
    .from(schema.proPlayers)
    .where(eq(schema.proPlayers.teamId, team.id));

  const playerStatsRows = await db
    .select({
      playerName: schema.proPlayerStats.playerName,
      position: schema.proPlayerStats.position,
      champion: schema.proPlayerStats.champion,
      result: schema.proPlayerStats.result,
      kills: schema.proPlayerStats.kills,
      deaths: schema.proPlayerStats.deaths,
      assists: schema.proPlayerStats.assists,
      cspm: schema.proPlayerStats.cspm,
      damageShare: schema.proPlayerStats.damageShare,
    })
    .from(schema.proPlayerStats)
    .where(eq(schema.proPlayerStats.teamName, team.teamName));

  const byPlayer = new Map<string, PlayerAggregate>();
  for (const row of playerStatsRows) {
    if (row.position === "TEAM") {
      continue;
    }

    const key = `${row.playerName}:${row.position}`;
    const aggregate = byPlayer.get(key) ?? {
      playerName: row.playerName,
      position: row.position,
      games: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      cspm: 0,
      damageShare: 0,
      championCounts: new Map<string, number>(),
    };

    aggregate.games += 1;
    aggregate.wins += row.result ? 1 : 0;
    aggregate.kills += row.kills ?? 0;
    aggregate.deaths += row.deaths ?? 0;
    aggregate.assists += row.assists ?? 0;
    aggregate.cspm += toNumber(row.cspm);
    aggregate.damageShare += toNumber(row.damageShare);
    aggregate.championCounts.set(
      row.champion,
      (aggregate.championCounts.get(row.champion) ?? 0) + 1,
    );

    byPlayer.set(key, aggregate);
  }

  const roster = rosterRows
    .map((player) => {
      const aggregate = byPlayer.get(`${player.playerName}:${player.position}`);
      const mostPlayedChampion = aggregate
        ? Array.from(aggregate.championCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-"
        : "-";

      const games = aggregate?.games ?? 0;
      const wins = aggregate?.wins ?? 0;
      const losses = Math.max(0, games - wins);
      const avgKills = games > 0 ? aggregate!.kills / games : 0;
      const avgDeaths = games > 0 ? aggregate!.deaths / games : 0;
      const avgAssists = games > 0 ? aggregate!.assists / games : 0;
      const kda = avgDeaths === 0 ? avgKills + avgAssists : (avgKills + avgAssists) / avgDeaths;

      return {
        playerName: player.playerName,
        position: player.position,
        games,
        wins,
        losses,
        kda: Number(kda.toFixed(2)),
        cspm: Number((games > 0 ? aggregate!.cspm / games : 0).toFixed(2)),
        damageShare: Number((games > 0 ? aggregate!.damageShare / games : 0).toFixed(3)),
        mostPlayedChampion,
      };
    })
    .sort((a, b) => a.position.localeCompare(b.position));

  const championPoolMap = new Map<string, { position: string; champion: string; games: number; wins: number }>();
  for (const row of playerStatsRows) {
    if (row.position === "TEAM") {
      continue;
    }

    const key = `${row.position}:${row.champion}`;
    const aggregate = championPoolMap.get(key) ?? {
      position: row.position,
      champion: row.champion,
      games: 0,
      wins: 0,
    };

    aggregate.games += 1;
    aggregate.wins += row.result ? 1 : 0;
    championPoolMap.set(key, aggregate);
  }

  const championPool = Array.from(championPoolMap.values())
    .map((entry) => ({
      ...entry,
      winRate: entry.games > 0 ? entry.wins / entry.games : 0,
    }))
    .sort((a, b) => {
      if (a.position !== b.position) {
        return a.position.localeCompare(b.position);
      }
      return b.games - a.games;
    })
    .slice(0, 40);

  const recentMatches = await db
    .select()
    .from(schema.proMatches)
    .where(
      or(
        eq(schema.proMatches.blueTeam, team.teamName),
        eq(schema.proMatches.redTeam, team.teamName),
      ),
    )
    .orderBy(desc(schema.proMatches.date))
    .limit(20);

  const trendMap = new Map<string, { games: number; wins: number }>();
  for (const match of recentMatches) {
    const bucket = monthBucket(match.date);
    const entry = trendMap.get(bucket) ?? { games: 0, wins: 0 };
    entry.games += 1;
    entry.wins += match.winner === team.teamName ? 1 : 0;
    trendMap.set(bucket, entry);
  }

  const trend = Array.from(trendMap.entries())
    .map(([bucket, entry]) => ({
      bucket,
      games: entry.games,
      winRate: entry.games > 0 ? entry.wins / entry.games : 0,
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  return NextResponse.json({
    team: {
      id: team.id,
      teamName: team.teamName,
      teamSlug: team.teamSlug,
      league: team.league,
      region: team.region,
      logoUrl: team.logoUrl,
      split,
      wins: latestTeamStats?.wins ?? team.wins ?? 0,
      losses: latestTeamStats?.losses ?? team.losses ?? 0,
      winRate: toNumber(latestTeamStats?.winRate ?? team.winRate),
    },
    teamStats: latestTeamStats ?? null,
    strengthProfile,
    roster,
    championPool,
    recentMatches,
    trend,
  });
}
