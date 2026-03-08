import {
  and,
  desc,
  eq,
  inArray,
  or,
} from "drizzle-orm";

import { db, schema } from "@/lib/db";

type TeamStanding = {
  teamName: string;
  teamSlug: string;
  league: string;
  region: string;
  logoUrl: string | null;
  wins: number;
  losses: number;
  winRate: number;
  split: string | null;
  gamesPlayed: number;
  streak: string;
};

function calculateStreak(results: boolean[]): string {
  if (results.length === 0) {
    return "N/A";
  }

  const first = results[0];
  let count = 0;
  for (const result of results) {
    if (result !== first) {
      break;
    }
    count += 1;
  }

  return `${first ? "W" : "L"}${count}`;
}

export async function GET(request: Request) {
  if (!process.env.DATABASE_URL) {
    return Response.json(
      {
        error: "DATABASE_URL is required.",
      },
      { status: 500 },
    );
  }

  const { searchParams } = new URL(request.url);
  const league = searchParams.get("league")?.trim();

  const teams = await db
    .select()
    .from(schema.proTeams)
    .where(league ? eq(schema.proTeams.league, league) : undefined)
    .orderBy(desc(schema.proTeams.winRate), desc(schema.proTeams.wins));

  if (teams.length === 0) {
    return Response.json({ teams: [] satisfies TeamStanding[] });
  }

  const teamNames = teams.map((team) => team.teamName);
  const stats = await db
    .select()
    .from(schema.proTeamStats)
    .where(
      and(
        league ? eq(schema.proTeamStats.league, league) : undefined,
        inArray(schema.proTeamStats.teamName, teamNames),
      ),
    )
    .orderBy(desc(schema.proTeamStats.computedAt));

  const latestStatsByTeam = new Map<string, (typeof stats)[number]>();
  for (const row of stats) {
    if (!latestStatsByTeam.has(row.teamName)) {
      latestStatsByTeam.set(row.teamName, row);
    }
  }

  const recentMatches = await db
    .select({
      blueTeam: schema.proMatches.blueTeam,
      redTeam: schema.proMatches.redTeam,
      winner: schema.proMatches.winner,
    })
    .from(schema.proMatches)
    .where(
      and(
        league ? eq(schema.proMatches.league, league) : undefined,
        or(
          ...teamNames.flatMap((teamName) => [
            eq(schema.proMatches.blueTeam, teamName),
            eq(schema.proMatches.redTeam, teamName),
          ]),
        ),
      ),
    )
    .orderBy(desc(schema.proMatches.date))
    .limit(800);

  const recentResultsByTeam = new Map<string, boolean[]>();
  for (const match of recentMatches) {
    for (const teamName of [match.blueTeam, match.redTeam]) {
      if (!teamNames.includes(teamName)) {
        continue;
      }
      const existing = recentResultsByTeam.get(teamName) ?? [];
      if (existing.length < 5) {
        existing.push(match.winner === teamName);
      }
      recentResultsByTeam.set(teamName, existing);
    }
  }

  const standings: TeamStanding[] = teams.map((team) => {
    const statsRow = latestStatsByTeam.get(team.teamName);
    const wins = Number(statsRow?.wins ?? team.wins ?? 0);
    const losses = Number(statsRow?.losses ?? team.losses ?? 0);
    const gamesPlayed = Number(statsRow?.gamesPlayed ?? wins + losses);
    const winRate =
      Number(statsRow?.winRate ?? team.winRate ?? (gamesPlayed > 0 ? wins / gamesPlayed : 0));

    return {
      teamName: team.teamName,
      teamSlug: team.teamSlug,
      league: team.league,
      region: team.region,
      logoUrl: team.logoUrl ?? null,
      wins,
      losses,
      winRate,
      split: statsRow?.split ?? team.split ?? null,
      gamesPlayed,
      streak: calculateStreak(recentResultsByTeam.get(team.teamName) ?? []),
    };
  });

  return Response.json({
    teams: standings,
  });
}
