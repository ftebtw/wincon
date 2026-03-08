"use client";

import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Minus,
} from "lucide-react";
import useSWR from "swr";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ErrorCard } from "@/components/ErrorCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type ProgressSnapshot = {
  period: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  winRate: number;
  avgKDA: number;
  avgCSPerMin: number;
  avgVisionScore: number;
  avgDeathsBefor10: number;
  avgGoldDiffAt10: number;
  avgDamageShare: number;
  rank: string;
  lp: number;
  topPatterns: string[];
};

type ProgressTrend = {
  metric: string;
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  direction: "improved" | "declined" | "stable";
  insight: string;
};

type ProgressReport = {
  current: ProgressSnapshot;
  previous: ProgressSnapshot;
  trends: ProgressTrend[];
  rankPrediction: {
    currentRank: string;
    predictedRank: string;
    confidence: "high" | "medium" | "low";
    gamesNeeded: number;
    reasoning: string;
  };
  improvementScore: number;
  streaks: {
    currentWinStreak: number;
    currentLossStreak: number;
    bestWinStreak: number;
    worstLossStreak: number;
  };
};

type ProgressDashboardProps = {
  puuid: string;
  initialReport?: ProgressReport | null;
  initialTimeline?: ProgressSnapshot[];
};

type ProgressFetchError = {
  status?: number;
  message: string;
};

type MetricCardConfig = {
  key: string;
  title: string;
  getSnapshotValue: (snapshot: ProgressSnapshot) => number;
  formatCurrent: (value: number) => string;
  formatChange: (value: number, percent: number) => string;
};

const METRIC_CARD_CONFIG: MetricCardConfig[] = [
  {
    key: "win_rate",
    title: "Win Rate",
    getSnapshotValue: (snapshot) => snapshot.winRate * 100,
    formatCurrent: (value) => `${value.toFixed(1)}%`,
    formatChange: (_value, percent) => `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`,
  },
  {
    key: "kda",
    title: "KDA",
    getSnapshotValue: (snapshot) => snapshot.avgKDA,
    formatCurrent: (value) => value.toFixed(2),
    formatChange: (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`,
  },
  {
    key: "cs_per_min",
    title: "CS/min",
    getSnapshotValue: (snapshot) => snapshot.avgCSPerMin,
    formatCurrent: (value) => value.toFixed(2),
    formatChange: (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`,
  },
  {
    key: "vision_score",
    title: "Vision Score",
    getSnapshotValue: (snapshot) => snapshot.avgVisionScore,
    formatCurrent: (value) => value.toFixed(1),
    formatChange: (_value, percent) => `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`,
  },
  {
    key: "deaths_before_10",
    title: "Deaths Before 10",
    getSnapshotValue: (snapshot) => snapshot.avgDeathsBefor10,
    formatCurrent: (value) => value.toFixed(2),
    formatChange: (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`,
  },
  {
    key: "gold_diff_at_10",
    title: "Gold Diff @10",
    getSnapshotValue: (snapshot) => snapshot.avgGoldDiffAt10,
    formatCurrent: (value) => `${value >= 0 ? "+" : ""}${Math.round(value)}`,
    formatChange: (value) => `${value >= 0 ? "+" : ""}${Math.round(value)}`,
  },
];

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function getGaugeColor(score: number): string {
  if (score < 30) {
    return "#ef4444";
  }
  if (score < 60) {
    return "#f59e0b";
  }
  if (score < 80) {
    return "#10b981";
  }
  return "#3b82f6";
}

function getDateRangeLabel(period: "week" | "month"): string {
  const now = new Date();

  if (period === "week") {
    const day = now.getDay() || 7;
    const start = new Date(now);
    start.setDate(now.getDate() - (day - 1));
    const end = new Date(start);
    end.setDate(start.getDate() + 6);

    return `${start.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })} - ${end.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })}`;
  }

  return now.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw {
      status: response.status,
      message: payload.error ?? "Failed to load progress data.",
    } satisfies ProgressFetchError;
  }

  return (await response.json()) as T;
}

function TrendSparkline({ data }: { data: Array<{ period: string; value: number }> }) {
  return (
    <div className="h-14 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="value"
            stroke="#60a5fa"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Tooltip
            formatter={(value) => Number(value).toFixed(2)}
            labelFormatter={(label) => `Period: ${String(label)}`}
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid rgba(148, 163, 184, 0.3)",
              color: "#e2e8f0",
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ProgressDashboard({
  puuid,
  initialReport = null,
  initialTimeline = [],
}: ProgressDashboardProps) {
  const [period, setPeriod] = useState<"week" | "month">("week");

  const reportKey = useMemo(
    () => `/api/progress/${encodeURIComponent(puuid)}?period=${period}`,
    [period, puuid],
  );
  const timelineKey = useMemo(
    () => `/api/progress/${encodeURIComponent(puuid)}/timeline?weeks=12`,
    [puuid],
  );

  const {
    data: report,
    error: reportError,
    isLoading: isReportLoading,
    mutate: refetchReport,
  } = useSWR<ProgressReport, ProgressFetchError>(reportKey, fetchJson, {
    fallbackData: period === "week" ? initialReport ?? undefined : undefined,
    revalidateOnFocus: true,
    refreshInterval: 5 * 60 * 1000,
    keepPreviousData: true,
  });

  const {
    data: timeline,
    error: timelineError,
    isLoading: isTimelineLoading,
    mutate: refetchTimeline,
  } = useSWR<ProgressSnapshot[], ProgressFetchError>(timelineKey, fetchJson, {
    fallbackData: initialTimeline.length > 0 ? initialTimeline : undefined,
    revalidateOnFocus: false,
    refreshInterval: 10 * 60 * 1000,
  });

  if (reportError || timelineError) {
    return (
      <ErrorCard
        statusCode={reportError?.status ?? timelineError?.status}
        title="Progress Data Unavailable"
        description={reportError?.message ?? timelineError?.message ?? "Failed to load progress data."}
        onRetry={() => {
          void refetchReport();
          void refetchTimeline();
        }}
      />
    );
  }

  if (!report || !timeline || isReportLoading || isTimelineLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-52 w-full" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-44 w-full" />
          ))}
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const gaugeColor = getGaugeColor(report.improvementScore);
  const gaugeAngle = Math.max(0, Math.min(360, report.improvementScore * 3.6));
  const dateRangeLabel = getDateRangeLabel(period);

  const metricCards = METRIC_CARD_CONFIG.map((config) => {
    const trend = report.trends.find((entry) => entry.metric === config.key);
    const sparkData = timeline.slice(-8).map((snapshot) => ({
      period: snapshot.period,
      value: config.getSnapshotValue(snapshot),
    }));

    return {
      config,
      trend,
      sparkData,
    };
  });

  const lpTimeline = timeline.map((snapshot, index) => ({
    period: snapshot.period,
    lp: snapshot.lp,
    winRate: snapshot.winRate * 100,
    rank: snapshot.rank,
    rankChanged: index > 0 && timeline[index - 1]?.rank !== snapshot.rank,
  }));

  const deathsTrend = report.trends.find((entry) => entry.metric === "deaths_before_10");
  const visionTrend = report.trends.find((entry) => entry.metric === "vision_score");
  const hasPatternShift = report.current.topPatterns.join("|") !== report.previous.topPatterns.join("|");

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-border/60 p-1">
          <Button
            type="button"
            size="sm"
            variant={period === "week" ? "default" : "ghost"}
            onClick={() => setPeriod("week")}
          >
            This Week
          </Button>
          <Button
            type="button"
            size="sm"
            variant={period === "month" ? "default" : "ghost"}
            onClick={() => setPeriod("month")}
          >
            This Month
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{dateRangeLabel}</p>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Improvement Score</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
            <div
              className="relative grid size-40 place-items-center rounded-full"
              style={{
                background: `conic-gradient(${gaugeColor} ${gaugeAngle}deg, rgba(148, 163, 184, 0.25) ${gaugeAngle}deg)`,
              }}
            >
              <div className="grid size-28 place-items-center rounded-full bg-[#0a0e14]">
                <p className="text-3xl font-bold" style={{ color: gaugeColor }}>
                  {report.improvementScore}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-lg font-semibold">
                Improvement Score: {report.improvementScore}
              </p>
              <p className="text-sm text-muted-foreground">
                {report.improvementScore >= 70
                  ? "You are trending up. Keep reinforcing current habits."
                  : report.improvementScore >= 45
                    ? "Progress is mixed. Tighten weak metrics to accelerate climbing."
                    : "Recent trend is down. Focus on the priority fixes below this week."}
              </p>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">Current streak W: {report.streaks.currentWinStreak}</Badge>
                <Badge variant="secondary">Current streak L: {report.streaks.currentLossStreak}</Badge>
                <Badge variant="outline">Best W streak: {report.streaks.bestWinStreak}</Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Rank Prediction</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="secondary">{report.rankPrediction.currentRank}</Badge>
              <ArrowRight className="size-4 text-muted-foreground" />
              <Badge>{report.rankPrediction.predictedRank}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {report.rankPrediction.gamesNeeded >= 999
                ? "Current LP trajectory is negative. Stabilize win rate to resume climbing."
                : `At your current rate, the next rank milestone is about ${report.rankPrediction.gamesNeeded} games away.`}
            </p>
            <p className="text-xs text-muted-foreground">{report.rankPrediction.reasoning}</p>
            <Badge variant="outline">
              Confidence: {report.rankPrediction.confidence.toUpperCase()}
            </Badge>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {metricCards.map(({ config, trend, sparkData }) => {
          const isImproved = trend?.direction === "improved";
          const isDeclined = trend?.direction === "declined";
          const changeIcon = isImproved ? (
            <ArrowUpRight className="size-4 text-[#10b981]" />
          ) : isDeclined ? (
            <ArrowDownRight className="size-4 text-[#ef4444]" />
          ) : (
            <Minus className="size-4 text-muted-foreground" />
          );

          return (
            <Card key={config.key}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{config.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-2xl font-semibold">
                    {trend ? config.formatCurrent(trend.current) : "--"}
                  </p>
                  <div
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                      isImproved
                        ? "border-[#10b981]/50 bg-[#10b981]/10 text-[#10b981]"
                        : isDeclined
                          ? "border-[#ef4444]/50 bg-[#ef4444]/10 text-[#ef4444]"
                          : "border-border/70 text-muted-foreground",
                    )}
                  >
                    {changeIcon}
                    {trend
                      ? config.formatChange(trend.change, trend.changePercent)
                      : "n/a"}
                  </div>
                </div>

                <TrendSparkline data={sparkData} />
                <p className="text-xs text-muted-foreground">{trend?.insight ?? "No insight available."}</p>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle>LP Progression (Last 12 Weeks)</CardTitle>
          </CardHeader>
          <CardContent className="h-[360px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={lpTimeline} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="rgba(148, 163, 184, 0.2)" strokeDasharray="4 4" />
                <XAxis
                  dataKey="period"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  minTickGap={24}
                />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  domain={[0, 100]}
                  tickFormatter={(value) => `${Math.round(value)}%`}
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                />
                <Tooltip
                  formatter={(value, name) => {
                    if (name === "winRate") {
                      return [`${Number(value).toFixed(1)}%`, "Win Rate"];
                    }

                    return [`${Math.round(Number(value))}`, "LP"];
                  }}
                  labelFormatter={(label) => `Period: ${String(label)}`}
                  contentStyle={{
                    backgroundColor: "#111827",
                    border: "1px solid rgba(148, 163, 184, 0.3)",
                    color: "#e2e8f0",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="lp"
                  stroke="#3b82f6"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: "#60a5fa" }}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="winRate"
                  stroke="#10b981"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={false}
                />
                {lpTimeline
                  .filter((point) => point.rankChanged)
                  .map((point) => (
                    <ReferenceDot
                      key={`${point.period}-rank-shift`}
                      x={point.period}
                      y={point.lp}
                      r={4}
                      fill="#f59e0b"
                      stroke="none"
                    />
                  ))}
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pattern Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Early deaths before 10: {report.previous.avgDeathsBefor10.toFixed(2)} {"->"}{" "}
              {report.current.avgDeathsBefor10.toFixed(2)} per game (
              {deathsTrend
                ? `${deathsTrend.direction === "improved" ? "improved" : deathsTrend.direction === "declined" ? "worse" : "stable"}`
                : "n/a"}
              ).
            </p>
            <p className="text-muted-foreground">
              Vision trend: {report.previous.avgVisionScore.toFixed(1)} {"->"}{" "}
              {report.current.avgVisionScore.toFixed(1)} (
              {visionTrend
                ? `${visionTrend.changePercent >= 0 ? "+" : ""}${visionTrend.changePercent.toFixed(1)}%`
                : "n/a"}
              ).
            </p>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Top Patterns This Period
              </p>
              <div className="flex flex-wrap gap-2">
                {report.current.topPatterns.length > 0 ? (
                  report.current.topPatterns.map((pattern) => (
                    <Badge key={pattern} variant="secondary">
                      {pattern}
                    </Badge>
                  ))
                ) : (
                  <Badge variant="outline">No major recurring issues detected</Badge>
                )}
              </div>
            </div>
            {hasPatternShift ? (
              <p className="text-xs text-muted-foreground">
                Pattern set changed from last period, indicating adaptation to prior coaching points.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Pattern set is unchanged. Focus on breaking one recurring mistake this week.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Progress Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              You went {report.current.wins}W-{report.current.losses}L this{" "}
              {period} ({formatPercent(report.current.winRate)}), compared to{" "}
              {report.previous.wins}W-{report.previous.losses}L last {period}.
            </p>
            <p>
              Strongest gains are in metrics marked as improved above, while declined metrics should
              be the next focus area for your next 10 ranked games.
            </p>
            <p>
              Current rank trajectory projects {report.rankPrediction.predictedRank} within roughly{" "}
              {report.rankPrediction.gamesNeeded >= 999
                ? "more than 100"
                : report.rankPrediction.gamesNeeded}{" "}
              games at current performance.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
