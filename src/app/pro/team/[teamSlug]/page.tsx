import Link from "next/link";
import { desc, eq, or } from "drizzle-orm";
import { notFound } from "next/navigation";

import { ProTeamRadar } from "@/components/ProTeamRadar";
import { ProWinRateLineChart } from "@/components/ProWinRateLineChart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db, schema } from "@/lib/db";
import { ProMatchPredictor } from "@/lib/pro-match-predictor";
import type { TeamStrengthProfile } from "@/lib/types/pro";

type ProTeamPageProps = {
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

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function duration(seconds: number | null): string {
  if (!seconds || seconds <= 0) {
    return "-";
  }
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m ${String(sec).padStart(2, "0")}s`;
}

function profileFromStats(row: (typeof schema.proTeamStats.$inferSelect) | null): TeamStrengthProfile {
  if (!row) {
    return {
      earlyGame: 50,
      objectiveControl: 50,
      teamfighting: 50,
      closingSpeed: 50,
      consistency: 50,
    };
  }

  const earlyGame = ((toNumber(row.firstBloodRate) + toNumber(row.firstDragonRate)) / 2) * 100;
  const objectiveControl = ((toNumber(row.firstDragonRate) + toNumber(row.firstBaronRate) + toNumber(row.firstTowerRate)) / 3) * 100;
  const teamfighting = ((toNumber(row.avgKillsPerGame) / Math.max(1, toNumber(row.avgDeathsPerGame) + 1)) * 35) + toNumber(row.winRate) * 45;
  const closingSpeed = (1 - toNumber(row.avgGameDuration) / 2600) * 100;

  return {
    earlyGame: Math.max(0, Math.min(100, earlyGame)),
    objectiveControl: Math.max(0, Math.min(100, objectiveControl)),
    teamfighting: Math.max(0, Math.min(100, teamfighting)),
    closingSpeed: Math.max(0, Math.min(100, closingSpeed)),
    consistency: 50,
  };
}

export default async function ProTeamPage({ params }: ProTeamPageProps) {
  const { teamSlug } = await params;

  const [team] = await db
    .select()
    .from(schema.proTeams)
    .where(eq(schema.proTeams.teamSlug, decodeURIComponent(teamSlug)))
    .limit(1);

  if (!team) {
    notFound();
  }

  const [latestStats] = await db
    .select()
    .from(schema.proTeamStats)
    .where(eq(schema.proTeamStats.teamName, team.teamName))
    .orderBy(desc(schema.proTeamStats.computedAt))
    .limit(1);

  const split = latestStats?.split ?? team.split ?? "Unknown";

  const predictor = new ProMatchPredictor();
  const strength = await predictor.getTeamStrengthProfile(team.teamName, split);

  const leagueRows = await db
    .select()
    .from(schema.proTeamStats)
    .where(eq(schema.proTeamStats.league, team.league))
    .orderBy(desc(schema.proTeamStats.computedAt))
    .limit(40);

  const leagueAverage = profileFromStats(
    leagueRows.length > 0
      ? {
          ...leagueRows[0],
          firstBloodRate: (leagueRows.reduce((sum, row) => sum + toNumber(row.firstBloodRate), 0) / leagueRows.length).toFixed(4),
          firstDragonRate: (leagueRows.reduce((sum, row) => sum + toNumber(row.firstDragonRate), 0) / leagueRows.length).toFixed(4),
          firstBaronRate: (leagueRows.reduce((sum, row) => sum + toNumber(row.firstBaronRate), 0) / leagueRows.length).toFixed(4),
          firstTowerRate: (leagueRows.reduce((sum, row) => sum + toNumber(row.firstTowerRate), 0) / leagueRows.length).toFixed(4),
          avgKillsPerGame: (leagueRows.reduce((sum, row) => sum + toNumber(row.avgKillsPerGame), 0) / leagueRows.length).toFixed(1),
          avgDeathsPerGame: (leagueRows.reduce((sum, row) => sum + toNumber(row.avgDeathsPerGame), 0) / leagueRows.length).toFixed(1),
          avgGameDuration: (leagueRows.reduce((sum, row) => sum + toNumber(row.avgGameDuration), 0) / leagueRows.length).toFixed(1),
          winRate: (leagueRows.reduce((sum, row) => sum + toNumber(row.winRate), 0) / leagueRows.length).toFixed(4),
        }
      : null,
  );

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
    aggregate.championCounts.set(row.champion, (aggregate.championCounts.get(row.champion) ?? 0) + 1);

    byPlayer.set(key, aggregate);
  }

  const roster = rosterRows
    .map((player) => {
      const aggregate = byPlayer.get(`${player.playerName}:${player.position}`);
      const games = aggregate?.games ?? 0;
      const avgKills = games > 0 ? aggregate!.kills / games : 0;
      const avgDeaths = games > 0 ? aggregate!.deaths / games : 0;
      const avgAssists = games > 0 ? aggregate!.assists / games : 0;
      const kda = avgDeaths === 0 ? avgKills + avgAssists : (avgKills + avgAssists) / avgDeaths;
      const mostPlayedChampion = aggregate
        ? Array.from(aggregate.championCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-"
        : "-";

      return {
        playerName: player.playerName,
        position: player.position,
        kda: Number(kda.toFixed(2)),
        cspm: Number((games > 0 ? aggregate!.cspm / games : 0).toFixed(2)),
        damageShare: Number((games > 0 ? aggregate!.damageShare / games : 0).toFixed(3)),
        mostPlayedChampion,
        games,
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
    .slice(0, 30);

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
    const bucket = match.date
      ? `${match.date.getUTCFullYear()}-${String(match.date.getUTCMonth() + 1).padStart(2, "0")}`
      : "Unknown";
    const aggregate = trendMap.get(bucket) ?? { games: 0, wins: 0 };
    aggregate.games += 1;
    aggregate.wins += match.winner === team.teamName ? 1 : 0;
    trendMap.set(bucket, aggregate);
  }

  const trend = Array.from(trendMap.entries())
    .map(([bucket, aggregate]) => ({
      bucket,
      games: aggregate.games,
      winRate: aggregate.games > 0 ? aggregate.wins / aggregate.games : 0,
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  const wins = toNumber(latestStats?.wins ?? team.wins);
  const losses = toNumber(latestStats?.losses ?? team.losses);
  const winRate = toNumber(latestStats?.winRate ?? team.winRate ?? 0);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-2xl">{team.teamName}</CardTitle>
            <Badge variant="secondary">{team.league}</Badge>
            <Badge variant="outline">{team.region}</Badge>
            <Badge variant="outline">{split}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Record: {wins}-{losses} ({pct(winRate)})
          </p>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Team Strength Radar</CardTitle>
        </CardHeader>
        <CardContent>
          <ProTeamRadar team={strength} leagueAverage={leagueAverage} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Roster</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          {roster.map((player) => (
            <div key={`${player.playerName}-${player.position}`} className="rounded-md border border-border/60 p-3">
              <p className="text-xs text-muted-foreground">{player.position}</p>
              <Link
                href={`/pro/player/${encodeURIComponent(player.playerName)}`}
                className="text-sm font-semibold text-primary hover:underline"
              >
                {player.playerName}
              </Link>
              <p className="mt-1 text-xs text-muted-foreground">Most played: {player.mostPlayedChampion}</p>
              <p className="text-xs text-muted-foreground">KDA {player.kda} | CS/min {player.cspm}</p>
              <p className="text-xs text-muted-foreground">Damage share {Math.round(player.damageShare * 100)}%</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Champion Pool</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="px-2 py-2">Role</th>
                <th className="px-2 py-2">Champion</th>
                <th className="px-2 py-2">Games</th>
                <th className="px-2 py-2">Win Rate</th>
              </tr>
            </thead>
            <tbody>
              {championPool.map((entry) => (
                <tr key={`${entry.position}-${entry.champion}`} className="border-b border-border/40">
                  <td className="px-2 py-2">{entry.position}</td>
                  <td className="px-2 py-2">{entry.champion}</td>
                  <td className="px-2 py-2">{entry.games}</td>
                  <td className="px-2 py-2">{pct(entry.winRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Matches</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {recentMatches.map((match) => (
            <Link
              key={match.gameId}
              href={`/pro/match/${encodeURIComponent(match.gameId)}`}
              className="block rounded-md border border-border/60 bg-background/40 px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p>
                  {match.blueTeam} vs {match.redTeam}
                </p>
                <p className="text-muted-foreground">Winner: {match.winner}</p>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>{match.date?.toLocaleDateString() ?? "TBD"}</span>
                <span>{duration(match.gameDuration)}</span>
                <span>Patch {match.patch ?? "-"}</span>
              </div>
            </Link>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stats Over Time</CardTitle>
        </CardHeader>
        <CardContent>
          <ProWinRateLineChart data={trend} />
        </CardContent>
      </Card>
    </div>
  );
}
