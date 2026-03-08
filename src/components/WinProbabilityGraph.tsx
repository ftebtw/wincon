"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { KeyMoment, WinProbPoint } from "@/lib/win-probability";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface WinProbabilityGraphProps {
  timeline: WinProbPoint[];
  keyMoments: KeyMoment[];
  onMomentClick?: (moment: KeyMoment) => void;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function WinProbabilityGraph({
  timeline,
  keyMoments,
  onMomentClick,
}: WinProbabilityGraphProps) {
  const chartData = timeline.map((point) => ({
    minute: point.minute,
    timestamp: point.timestamp,
    winProbability: point.winProbability,
    gameState: point.gameState,
  }));

  const handleMomentClick = (moment: KeyMoment) => {
    onMomentClick?.(moment);

    const card = document.getElementById(`moment-${moment.timestamp}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  return (
    <Card className="border-border/70">
      <CardHeader>
        <CardTitle>Win Probability Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[200px] w-full md:h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 12, right: 16, left: 0, bottom: 8 }}>
              <defs>
                <linearGradient id="winProbGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
                  <stop offset="49%" stopColor="#3b82f6" stopOpacity={0.25} />
                  <stop offset="51%" stopColor="#ef4444" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0.35} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="3 3" stroke="#273147" />
              <XAxis
                dataKey="minute"
                tickFormatter={(value) => `${value}m`}
                stroke="#94a3b8"
              />
              <YAxis
                domain={[0, 1]}
                tickFormatter={(value) => formatPercent(value)}
                stroke="#94a3b8"
              />
              <ReferenceLine y={0.5} stroke="#94a3b8" strokeDasharray="4 4" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#121826",
                  border: "1px solid #273147",
                  borderRadius: "0.75rem",
                }}
                formatter={(value) => formatPercent(value as number)}
                labelFormatter={(label) => `Minute ${label}`}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) {
                    return null;
                  }

                  const point = payload[0]?.payload as (typeof chartData)[number];
                  return (
                    <div className="rounded-lg border border-border/70 bg-card px-3 py-2 text-xs">
                      <p className="font-semibold text-foreground">
                        Minute {point.minute} - {formatPercent(point.winProbability)}
                      </p>
                      <p className="text-muted-foreground">
                        Gold diff: {point.gameState.goldDiff >= 0 ? "+" : ""}
                        {point.gameState.goldDiff}
                      </p>
                      <p className="text-muted-foreground">
                        Kills: {point.gameState.killDiff >= 0 ? "+" : ""}
                        {point.gameState.killDiff} | Towers:{" "}
                        {point.gameState.towerDiff >= 0 ? "+" : ""}
                        {point.gameState.towerDiff}
                      </p>
                    </div>
                  );
                }}
              />

              <Area
                type="monotone"
                dataKey="winProbability"
                stroke="#60a5fa"
                strokeWidth={2.2}
                fill="url(#winProbGradient)"
                dot={false}
                isAnimationActive={false}
              />

              {keyMoments.map((moment) => {
                const point = timeline.find((entry) => entry.minute === moment.minute);
                if (!point) {
                  return null;
                }

                const radius = Math.max(5, Math.min(12, 5 + Math.abs(moment.totalDelta) * 45));
                const color = moment.type === "positive" ? "#10b981" : "#ef4444";

                return (
                  <ReferenceDot
                    key={`${moment.timestamp}-${moment.minute}`}
                    x={point.minute}
                    y={point.winProbability}
                    r={radius}
                    fill={color}
                    stroke="#0a0e14"
                    strokeWidth={2}
                    ifOverflow="extendDomain"
                    onClick={() => handleMomentClick(moment)}
                  >
                    <title>
                      {`${formatTimestamp(moment.timestamp)} | ${moment.description} | ${Math.round(moment.totalDelta * 100)}%`}
                    </title>
                  </ReferenceDot>
                );
              })}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
