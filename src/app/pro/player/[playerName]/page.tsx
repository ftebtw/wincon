import Image from "next/image";
import Link from "next/link";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getChampionIconUrl, getItemIconUrl } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";
import { getProBuildsForChampion } from "@/lib/pro-insights";

type ProPlayerPageProps = {
  params: Promise<{
    playerName: string;
  }>;
};

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export default async function ProPlayerPage({ params }: ProPlayerPageProps) {
  const { playerName: rawPlayerName } = await params;
  const playerName = decodeURIComponent(rawPlayerName);

  const [profile] = await db
    .select()
    .from(schema.proPlayers)
    .where(eq(schema.proPlayers.playerName, playerName))
    .orderBy(desc(schema.proPlayers.lastUpdated))
    .limit(1);

  const statsRows = await db
    .select()
    .from(schema.proPlayerStats)
    .where(and(eq(schema.proPlayerStats.playerName, playerName), ne(schema.proPlayerStats.position, "TEAM")))
    .orderBy(desc(schema.proPlayerStats.id))
    .limit(400);

  if (statsRows.length === 0) {
    notFound();
  }

  const games = statsRows.length;
  const wins = statsRows.filter((row) => row.result).length;
  const kills = statsRows.reduce((sum, row) => sum + (row.kills ?? 0), 0);
  const deaths = statsRows.reduce((sum, row) => sum + (row.deaths ?? 0), 0);
  const assists = statsRows.reduce((sum, row) => sum + (row.assists ?? 0), 0);

  const seasonStats = {
    games,
    wins,
    losses: games - wins,
    winRate: games > 0 ? wins / games : 0,
    kda: deaths === 0 ? kills + assists : (kills + assists) / deaths,
    cspm: statsRows.reduce((sum, row) => sum + toNumber(row.cspm), 0) / games,
    damageShare: statsRows.reduce((sum, row) => sum + toNumber(row.damageShare), 0) / games,
    goldShare: statsRows.reduce((sum, row) => sum + toNumber(row.goldShare), 0) / games,
    vision: statsRows.reduce((sum, row) => sum + toNumber(row.visionScore), 0) / games,
    csAt10: statsRows.reduce((sum, row) => sum + toNumber(row.csAt10), 0) / games,
    goldAt10: statsRows.reduce((sum, row) => sum + toNumber(row.goldAt10), 0) / games,
    goldDiffAt10: statsRows.reduce((sum, row) => sum + toNumber(row.goldDiffAt10), 0) / games,
  };

  const championMap = new Map<string, { champion: string; games: number; wins: number; kills: number; deaths: number; assists: number }>();
  for (const row of statsRows) {
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

  const topChampions = championPool.slice(0, 6);
  const role = profile?.position ?? statsRows[0].position;

  const buildsByChampion = await Promise.all(
    topChampions.map(async (entry) => {
      const builds = await getProBuildsForChampion({
        champion: entry.champion,
        role,
        recentGames: 250,
      });

      return {
        champion: entry.champion,
        builds: builds.slice(0, 2),
      };
    }),
  );

  const recentMatchIds = Array.from(
    new Set(
      statsRows
        .map((row) => row.gameId)
        .filter((gameId): gameId is string => typeof gameId === "string"),
    ),
  ).slice(0, 30);

  const matchRows = recentMatchIds.length > 0
    ? await db
        .select()
        .from(schema.proMatches)
        .where(inArray(schema.proMatches.gameId, recentMatchIds))
    : [];

  const matchById = new Map(matchRows.map((match) => [match.gameId, match]));

  const recentGames = statsRows.slice(0, 20).map((row) => ({
    gameId: row.gameId,
    champion: row.champion,
    result: row.result,
    kda: `${row.kills ?? 0}/${row.deaths ?? 0}/${row.assists ?? 0}`,
    cspm: toNumber(row.cspm),
    league: row.gameId ? matchById.get(row.gameId)?.league ?? "-" : "-",
    date: row.gameId ? matchById.get(row.gameId)?.date ?? null : null,
    patch: row.gameId ? matchById.get(row.gameId)?.patch ?? null : null,
  }));

  const positionRows = await db
    .select({
      cspm: schema.proPlayerStats.cspm,
      csAt10: schema.proPlayerStats.csAt10,
      goldAt10: schema.proPlayerStats.goldAt10,
      goldDiffAt10: schema.proPlayerStats.goldDiffAt10,
    })
    .from(schema.proPlayerStats)
    .where(eq(schema.proPlayerStats.position, role));

  const positionAvg = {
    cspm:
      positionRows.length > 0
        ? positionRows.reduce((sum, row) => sum + toNumber(row.cspm), 0) / positionRows.length
        : 0,
    csAt10:
      positionRows.length > 0
        ? positionRows.reduce((sum, row) => sum + toNumber(row.csAt10), 0) / positionRows.length
        : 0,
    goldAt10:
      positionRows.length > 0
        ? positionRows.reduce((sum, row) => sum + toNumber(row.goldAt10), 0) / positionRows.length
        : 0,
    goldDiffAt10:
      positionRows.length > 0
        ? positionRows.reduce((sum, row) => sum + toNumber(row.goldDiffAt10), 0) / positionRows.length
        : 0,
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-2xl">{playerName}</CardTitle>
            <Badge variant="secondary">{role}</Badge>
            <Badge variant="outline">{profile?.league ?? "Pro"}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">Team ID: {profile?.teamId ?? "Unknown"}</p>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Season Stats</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-md border border-border/60 p-3 text-sm">
            <p className="text-muted-foreground">Record</p>
            <p className="font-semibold">{seasonStats.wins}-{seasonStats.losses} ({pct(seasonStats.winRate)})</p>
          </div>
          <div className="rounded-md border border-border/60 p-3 text-sm">
            <p className="text-muted-foreground">KDA</p>
            <p className="font-semibold">{seasonStats.kda.toFixed(2)}</p>
          </div>
          <div className="rounded-md border border-border/60 p-3 text-sm">
            <p className="text-muted-foreground">CS/min</p>
            <p className="font-semibold">{seasonStats.cspm.toFixed(2)}</p>
          </div>
          <div className="rounded-md border border-border/60 p-3 text-sm">
            <p className="text-muted-foreground">Damage Share</p>
            <p className="font-semibold">{pct(seasonStats.damageShare)}</p>
          </div>
          <div className="rounded-md border border-border/60 p-3 text-sm">
            <p className="text-muted-foreground">Gold Share</p>
            <p className="font-semibold">{pct(seasonStats.goldShare)}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Champion Pool</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="px-2 py-2">Champion</th>
                <th className="px-2 py-2">Games</th>
                <th className="px-2 py-2">Win Rate</th>
                <th className="px-2 py-2">KDA</th>
              </tr>
            </thead>
            <tbody>
              {championPool.map((entry) => (
                <tr key={entry.champion} className="border-b border-border/40">
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <Image
                        src={getChampionIconUrl(entry.champion)}
                        alt={entry.champion}
                        width={26}
                        height={26}
                        className="size-6 rounded"
                      />
                      <span>{entry.champion}</span>
                    </div>
                  </td>
                  <td className="px-2 py-2">{entry.games}</td>
                  <td className="px-2 py-2">{pct(entry.winRate)}</td>
                  <td className="px-2 py-2">{entry.kda}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What Pros Build</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {buildsByChampion.map((entry) => (
            <div key={entry.champion} className="rounded-md border border-border/60 p-3">
              <p className="mb-2 text-sm font-semibold">{entry.champion}</p>
              <div className="space-y-2">
                {entry.builds.map((build, index) => (
                  <div key={`${entry.champion}-${index}`} className="rounded-md border border-border/40 bg-background/40 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {build.buildPath.slice(0, 6).map((itemId) => (
                        <Image
                          key={`${entry.champion}-${index}-${itemId}`}
                          src={getItemIconUrl(itemId)}
                          alt={`Item ${itemId}`}
                          width={28}
                          height={28}
                          className="size-7 rounded"
                        />
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {build.games} games, {pct(build.winRate)} WR
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Early Game Stats</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <div className="rounded-md border border-border/60 p-3">
            <p className="text-muted-foreground">CS@10</p>
            <p className="font-semibold">{seasonStats.csAt10.toFixed(1)} (pos avg {positionAvg.csAt10.toFixed(1)})</p>
          </div>
          <div className="rounded-md border border-border/60 p-3">
            <p className="text-muted-foreground">Gold@10</p>
            <p className="font-semibold">{Math.round(seasonStats.goldAt10)} (pos avg {Math.round(positionAvg.goldAt10)})</p>
          </div>
          <div className="rounded-md border border-border/60 p-3">
            <p className="text-muted-foreground">GoldDiff@10</p>
            <p className="font-semibold">{Math.round(seasonStats.goldDiffAt10)} (pos avg {Math.round(positionAvg.goldDiffAt10)})</p>
          </div>
          <div className="rounded-md border border-border/60 p-3">
            <p className="text-muted-foreground">CS/min</p>
            <p className="font-semibold">{seasonStats.cspm.toFixed(2)} (pos avg {positionAvg.cspm.toFixed(2)})</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Games</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {recentGames.map((game, index) => (
            <Link
              key={`${game.gameId ?? index}`}
              href={game.gameId ? `/pro/match/${encodeURIComponent(game.gameId)}` : "#"}
              className="block rounded-md border border-border/60 bg-background/40 px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p>
                  {game.champion} - {game.kda}
                </p>
                <Badge variant={game.result ? "default" : "destructive"}>{game.result ? "WIN" : "LOSS"}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {game.league} | {game.patch ?? "-"} | {game.date ? game.date.toLocaleDateString() : "TBD"}
              </p>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
