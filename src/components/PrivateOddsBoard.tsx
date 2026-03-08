"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type OddsBoardFixture = {
  fixture: {
    id: string;
    league: string;
    startTime: string;
    status: "pre" | "live" | "ended";
    homeTeam: string;
    awayTeam: string;
  };
  market: string;
  bookmakers: Array<{
    bookmaker: string;
    homeOdds: number;
    awayOdds: number;
    margin: number;
    deepLink?: string;
  }>;
  bestOdds: {
    bestHome: { bookmaker: string; homeOdds: number; deepLink?: string };
    bestAway: { bookmaker: string; awayOdds: number; deepLink?: string };
    pinnacle?: { homeOdds: number; awayOdds: number } | null;
    arbitrageExists: boolean;
    arbitragePercent?: number;
  };
  prediction: {
    team1WinProb: number;
    team2WinProb: number;
  } | null;
  edgeVsPinnacle: number;
  edgeVsBest: number;
  recommendedBookmaker: string;
  recommendedOdds: number;
  recommendedSide: "home" | "away";
  deepLink: string | null;
  polymarketAvailable: boolean;
};

type OddsBoardResponse = {
  fixtures: OddsBoardFixture[];
  fetchedAt: string;
};

type FixtureDetailResponse = {
  fixtureOdds: {
    fixture: {
      id: string;
      homeTeam: string;
      awayTeam: string;
    };
    bookmakers: Array<{
      bookmaker: string;
      homeOdds: number;
      awayOdds: number;
      margin: number;
      deepLink?: string;
    }>;
  };
  bestOdds: {
    bestHome: { bookmaker: string; homeOdds: number; deepLink?: string };
    bestAway: { bookmaker: string; awayOdds: number; deepLink?: string };
    pinnacle?: { homeOdds: number; awayOdds: number } | null;
    arbitrageExists: boolean;
    arbitragePercent?: number;
  };
  history: Array<{
    timestamp: string;
    bookmaker: string;
    previousHomeOdds: number;
    currentHomeOdds: number;
    previousAwayOdds: number;
    currentAwayOdds: number;
    direction: string;
    magnitude: number;
  }>;
};

const fetcher = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
};

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatOdds(value: number): string {
  return value.toFixed(2);
}

function marginPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function PrivateOddsBoard({ refreshIntervalMs }: { refreshIntervalMs: number }) {
  const { data, error, isLoading } = useSWR<OddsBoardResponse>(
    "/api/private/betting/odds",
    fetcher,
    {
      refreshInterval: refreshIntervalMs,
      revalidateOnFocus: true,
    },
  );

  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);

  const fixtures = useMemo(() => data?.fixtures ?? [], [data]);
  const grouped = useMemo(() => {
    const map = new Map<string, OddsBoardFixture[]>();
    for (const fixture of fixtures) {
      const league = fixture.fixture.league || "Unknown";
      const rows = map.get(league) ?? [];
      rows.push(fixture);
      map.set(league, rows);
    }

    for (const rows of map.values()) {
      rows.sort(
        (a, b) =>
          new Date(a.fixture.startTime).getTime() -
          new Date(b.fixture.startTime).getTime(),
      );
    }

    return Array.from(map.entries());
  }, [fixtures]);

  const selectedId = selectedFixtureId ?? fixtures[0]?.fixture.id ?? null;

  const { data: detailData } = useSWR<FixtureDetailResponse>(
    selectedId ? `/api/private/betting/odds/${encodeURIComponent(selectedId)}` : null,
    fetcher,
    {
      refreshInterval: refreshIntervalMs,
      revalidateOnFocus: true,
    },
  );

  const chartData = useMemo(() => {
    const history = detailData?.history ?? [];
    const selectedFixture = fixtures.find((entry) => entry.fixture.id === selectedId);
    const modelHome = selectedFixture?.prediction?.team1WinProb
      ? 1 / Math.max(selectedFixture.prediction.team1WinProb, 0.0001)
      : null;

    return history
      .slice(-40)
      .map((entry) => ({
        time: new Date(entry.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        homeOdds: entry.currentHomeOdds,
        awayOdds: entry.currentAwayOdds,
        modelHomeOdds: modelHome,
      }));
  }, [detailData, fixtures, selectedId]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Live Odds Board</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading odds...</p> : null}
          {error ? (
            <p className="text-sm text-[#f87171]">
              Unable to load odds right now.
            </p>
          ) : null}
          {data?.fetchedAt ? (
            <p className="text-xs text-muted-foreground">
              Last updated {new Date(data.fetchedAt).toLocaleTimeString()} · refreshes every {Math.round(refreshIntervalMs / 1000)}s
            </p>
          ) : null}

          {grouped.length === 0 && !isLoading ? (
            <p className="text-sm text-muted-foreground">No upcoming LoL fixtures available from OddsPapi.</p>
          ) : null}

          {grouped.map(([league, rows]) => (
            <div key={league} className="space-y-2">
              <p className="text-sm font-semibold text-foreground">{league}</p>
              <div className="space-y-2">
                {rows.map((row) => {
                  const isSelected = selectedId === row.fixture.id;
                  const edge = row.edgeVsBest;
                  const positive = edge > 0;
                  return (
                    <button
                      key={row.fixture.id}
                      type="button"
                      onClick={() => setSelectedFixtureId(row.fixture.id)}
                      className={`w-full rounded border p-3 text-left text-sm ${
                        isSelected
                          ? "border-primary/60 bg-primary/10"
                          : "border-border/60 bg-background/20"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">
                          {row.fixture.homeTeam} vs {row.fixture.awayTeam}
                        </p>
                        <div className="flex items-center gap-2">
                          <Badge variant={row.fixture.status === "live" ? "destructive" : "secondary"}>
                            {row.fixture.status.toUpperCase()}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(row.fixture.startTime).toLocaleString()}
                          </span>
                        </div>
                      </div>

                      <p className="mt-1 text-xs text-muted-foreground">
                        Pinnacle: {row.bestOdds.pinnacle ? `${formatOdds(row.bestOdds.pinnacle.homeOdds)} / ${formatOdds(row.bestOdds.pinnacle.awayOdds)}` : "n/a"} ·
                        Model: {row.prediction ? `${pct(row.prediction.team1WinProb)} / ${pct(row.prediction.team2WinProb)}` : "n/a"}
                      </p>

                      <p className="mt-1 text-xs text-muted-foreground">
                        Best {row.fixture.homeTeam}: {formatOdds(row.bestOdds.bestHome.homeOdds)} ({row.bestOdds.bestHome.bookmaker}) ·
                        Best {row.fixture.awayTeam}: {formatOdds(row.bestOdds.bestAway.awayOdds)} ({row.bestOdds.bestAway.bookmaker})
                      </p>

                      <p className={`mt-1 text-xs ${positive ? "text-[#34d399]" : "text-muted-foreground"}`}>
                        Edge: {(edge * 100).toFixed(2)}% on {row.recommendedSide.toUpperCase()} ·
                        Recommended: {row.recommendedBookmaker} @ {formatOdds(row.recommendedOdds)}
                      </p>

                      {row.bestOdds.arbitrageExists ? (
                        <p className="mt-1 text-xs text-[#fbbf24]">
                          Arbitrage detected: {row.bestOdds.arbitragePercent?.toFixed(2)}% guaranteed spread.
                        </p>
                      ) : null}

                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {row.deepLink ? (
                          <Link
                            href={row.deepLink}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex rounded border border-border/60 px-2 py-1 text-xs text-primary hover:bg-primary/10"
                          >
                            Deep Link
                          </Link>
                        ) : null}
                        {row.polymarketAvailable ? (
                          <Badge variant="outline">Polymarket available</Badge>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Odds Movement Chart</CardTitle>
          </CardHeader>
          <CardContent className="h-[280px]">
            {chartData.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No historical movement data available for the selected fixture.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="time" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                  <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} domain={["dataMin - 0.05", "dataMax + 0.05"]} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="homeOdds" stroke="#3b82f6" dot={false} name="Home Odds" />
                  <Line type="monotone" dataKey="awayOdds" stroke="#ef4444" dot={false} name="Away Odds" />
                  <Line
                    type="monotone"
                    dataKey="modelHomeOdds"
                    stroke="#f59e0b"
                    dot={false}
                    strokeDasharray="6 4"
                    name="Model Home Fair Odds"
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bookmaker Comparison</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-muted-foreground">
                  <th className="px-2 py-2">Bookmaker</th>
                  <th className="px-2 py-2">Home</th>
                  <th className="px-2 py-2">Away</th>
                  <th className="px-2 py-2">Margin</th>
                  <th className="px-2 py-2">Link</th>
                </tr>
              </thead>
              <tbody>
                {(detailData?.fixtureOdds.bookmakers ?? []).map((book) => {
                  const bestHome =
                    detailData?.bestOdds.bestHome.bookmaker === book.bookmaker;
                  const bestAway =
                    detailData?.bestOdds.bestAway.bookmaker === book.bookmaker;

                  return (
                    <tr key={book.bookmaker} className="border-b border-border/40">
                      <td className="px-2 py-2 font-medium capitalize">{book.bookmaker.replace(/_/g, " ")}</td>
                      <td className="px-2 py-2">
                        {formatOdds(book.homeOdds)} {bestHome ? "?" : ""}
                      </td>
                      <td className="px-2 py-2">
                        {formatOdds(book.awayOdds)} {bestAway ? "?" : ""}
                      </td>
                      <td className="px-2 py-2">{marginPct(book.margin)}</td>
                      <td className="px-2 py-2">
                        {book.deepLink ? (
                          <Link href={book.deepLink} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                            Bet
                          </Link>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {detailData?.bestOdds.arbitrageExists ? (
        <Card>
          <CardHeader>
            <CardTitle>Arbitrage Scanner</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            <p>
              Arbitrage detected on selected fixture: {detailData.bestOdds.arbitragePercent?.toFixed(2)}% edge.
            </p>
            <p>
              Buy home at {formatOdds(detailData.bestOdds.bestHome.homeOdds)} ({detailData.bestOdds.bestHome.bookmaker}) and away at {formatOdds(detailData.bestOdds.bestAway.awayOdds)} ({detailData.bestOdds.bestAway.bookmaker}).
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

