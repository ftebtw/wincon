import Link from "next/link";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";

import { ProLivePanel } from "@/components/ProLivePanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db, schema } from "@/lib/db";
import { ProMatchPredictor } from "@/lib/pro-match-predictor";

type ProLandingPageProps = {
  searchParams: Promise<{
    league?: string;
    sort?: string;
  }>;
};

const LEAGUES = ["LCK", "LCS", "LEC", "LPL", "Other"] as const;

type StandingRow = {
  teamName: string;
  teamSlug: string;
  league: string;
  wins: number;
  losses: number;
  winRate: number;
  gamesPlayed: number;
};

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export default async function ProLandingPage({ searchParams }: ProLandingPageProps) {
  const { league: rawLeague, sort: rawSort } = await searchParams;
  const selectedLeague = rawLeague && LEAGUES.includes(rawLeague as (typeof LEAGUES)[number])
    ? rawLeague
    : "LCK";
  const sort = rawSort === "games" ? "games" : "winrate";

  let standings: StandingRow[] = [];
  let prediction: Awaited<ReturnType<ProMatchPredictor["predictMatch"]>> | null = null;
  let loadError: string | null = null;

  try {
    const teamFilters: SQL[] = [];
    if (selectedLeague !== "Other") {
      teamFilters.push(eq(schema.proTeams.league, selectedLeague));
    }

    const teamRows = await db
      .select()
      .from(schema.proTeams)
      .where(teamFilters.length > 0 ? and(...teamFilters) : undefined);

    const teamNames = teamRows.map((team) => team.teamName);

    const statsFilters: SQL[] = [];
    if (selectedLeague !== "Other") {
      statsFilters.push(eq(schema.proTeamStats.league, selectedLeague));
    }
    if (teamNames.length > 0) {
      statsFilters.push(inArray(schema.proTeamStats.teamName, teamNames));
    }

    const statsRows = teamNames.length > 0
      ? await db
          .select()
          .from(schema.proTeamStats)
          .where(statsFilters.length > 0 ? and(...statsFilters) : undefined)
          .orderBy(desc(schema.proTeamStats.computedAt))
      : [];

    const latestByTeam = new Map<string, (typeof statsRows)[number]>();
    for (const row of statsRows) {
      if (!latestByTeam.has(row.teamName)) {
        latestByTeam.set(row.teamName, row);
      }
    }

    standings = teamRows.map((team) => {
      const latest = latestByTeam.get(team.teamName);
      const wins = toNumber(latest?.wins ?? team.wins);
      const losses = toNumber(latest?.losses ?? team.losses);
      const gamesPlayed = toNumber(latest?.gamesPlayed ?? wins + losses);
      const winRate = toNumber(latest?.winRate ?? team.winRate ?? (gamesPlayed > 0 ? wins / gamesPlayed : 0));

      return {
        teamName: team.teamName,
        teamSlug: team.teamSlug,
        league: team.league,
        wins,
        losses,
        winRate,
        gamesPlayed,
      };
    });

    standings.sort((a, b) => {
      if (sort === "games") {
        if (b.gamesPlayed !== a.gamesPlayed) {
          return b.gamesPlayed - a.gamesPlayed;
        }
        return b.winRate - a.winRate;
      }

      if (b.winRate !== a.winRate) {
        return b.winRate - a.winRate;
      }

      return b.gamesPlayed - a.gamesPlayed;
    });

    if (standings.length >= 2 && selectedLeague !== "Other") {
      const predictor = new ProMatchPredictor();
      prediction = await predictor.predictMatch(
        standings[0].teamName,
        standings[1].teamName,
        selectedLeague,
      );
    }
  } catch (error) {
    console.error("[ProPage] Failed to load standings.", error);
    standings = [];
    prediction = null;
    loadError = "Pro data is temporarily unavailable. Live banner and other sections will keep working.";
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-wrap items-center gap-2">
        {LEAGUES.map((league) => (
          <Link
            key={league}
            href={`/pro?league=${encodeURIComponent(league)}&sort=${sort}`}
            className={`rounded-full border px-3 py-1.5 text-sm ${
              selectedLeague === league
                ? "border-primary bg-primary/20 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {league}
          </Link>
        ))}
      </div>

      <ProLivePanel
        leagueSlug={selectedLeague === "Other" ? undefined : selectedLeague.toLowerCase()}
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Standings</CardTitle>
          <div className="flex items-center gap-2 text-xs">
            <Link
              href={`/pro?league=${encodeURIComponent(selectedLeague)}&sort=winrate`}
              className={`rounded px-2 py-1 ${sort === "winrate" ? "bg-primary/20 text-primary" : "text-muted-foreground"}`}
            >
              Sort: Win Rate
            </Link>
            <Link
              href={`/pro?league=${encodeURIComponent(selectedLeague)}&sort=games`}
              className={`rounded px-2 py-1 ${sort === "games" ? "bg-primary/20 text-primary" : "text-muted-foreground"}`}
            >
              Sort: Games
            </Link>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {loadError ? (
            <p className="text-sm text-muted-foreground">{loadError}</p>
          ) : null}
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="px-2 py-2">Team</th>
                <th className="px-2 py-2">Record</th>
                <th className="px-2 py-2">Win Rate</th>
                <th className="px-2 py-2">Games</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((team) => (
                <tr key={team.teamSlug} className="border-b border-border/40">
                  <td className="px-2 py-2 font-medium">
                    <Link
                      href={`/pro/team/${encodeURIComponent(team.teamSlug)}`}
                      className="text-primary hover:underline"
                    >
                      {team.teamName}
                    </Link>
                  </td>
                  <td className="px-2 py-2">{team.wins}-{team.losses}</td>
                  <td className="px-2 py-2">{formatPercent(team.winRate)}</td>
                  <td className="px-2 py-2">{team.gamesPlayed}</td>
                </tr>
              ))}
              {standings.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-muted-foreground" colSpan={4}>
                    No standings data available yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {prediction ? (
        <Card>
          <CardHeader>
            <CardTitle>Match Predictor</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upcoming model spotlight: {prediction.team1} vs {prediction.team2}
            </p>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>{prediction.team1}</span>
                <span>{formatPercent(prediction.team1WinProb)}</span>
              </div>
              <div className="h-3 rounded-full bg-border/60">
                <div
                  className="h-3 rounded-full bg-[#3b82f6]"
                  style={{ width: `${Math.round(prediction.team1WinProb * 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span>{prediction.team2}</span>
                <span>{formatPercent(prediction.team2WinProb)}</span>
              </div>
              <p className="text-xs text-muted-foreground">Confidence: {prediction.confidence}</p>
            </div>
            <div className="space-y-1 text-sm text-muted-foreground">
              {prediction.keyFactors.map((factor) => (
                <p key={factor.factor}>- {factor.factor}</p>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Based on season stats. Not betting advice.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
