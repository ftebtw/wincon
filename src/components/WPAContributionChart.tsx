"use client";

import {
  Area,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WPAEvent } from "@/lib/wpa-engine";
import type { WinProbPoint } from "@/lib/win-probability";

export interface WPAContributionChartProps {
  teamWinProbTimeline: WinProbPoint[];
  playerWPATimeline: { minute: number; cumulativeWPA: number }[];
  keyEvents: WPAEvent[];
  onEventClick?: (event: WPAEvent) => void;
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

function cumulativeAtMinute(
  points: { minute: number; cumulativeWPA: number }[],
  minute: number,
): number {
  let value = 0;
  for (const point of points) {
    if (point.minute <= minute) {
      value = point.cumulativeWPA;
    } else {
      break;
    }
  }
  return value;
}

export function WPAContributionChart({
  teamWinProbTimeline,
  playerWPATimeline,
  keyEvents,
  onEventClick,
}: WPAContributionChartProps) {
  const sortedWpaTimeline = [...playerWPATimeline].sort((a, b) => a.minute - b.minute);
  const chartData = teamWinProbTimeline.map((point) => ({
    minute: point.minute,
    winProbability: point.winProbability,
    cumulativeWPA: cumulativeAtMinute(sortedWpaTimeline, point.minute),
  }));

  const maxAbsWpa = Math.max(
    0.05,
    ...chartData.map((point) => Math.abs(point.cumulativeWPA)),
  );
  const wpaDomain = [-(maxAbsWpa + 0.03), maxAbsWpa + 0.03] as const;

  const wpaByMinute = new Map<number, number>();
  for (const point of chartData) {
    wpaByMinute.set(point.minute, point.cumulativeWPA);
  }

  return (
    <Card className="border-border/70">
      <CardHeader>
        <CardTitle>Win Probability + Your Cumulative WPA</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[220px] w-full md:h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 8 }}>
              <defs>
                <linearGradient id="wpaWinProbGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="49%" stopColor="#3b82f6" stopOpacity={0.22} />
                  <stop offset="51%" stopColor="#ef4444" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0.3} />
                </linearGradient>
              </defs>

              <XAxis
                dataKey="minute"
                tickFormatter={(value) => `${value}m`}
                stroke="#94a3b8"
              />
              <YAxis
                yAxisId="winProb"
                domain={[0, 1]}
                tickFormatter={(value) => formatPercent(value)}
                stroke="#94a3b8"
              />
              <YAxis
                yAxisId="wpa"
                orientation="right"
                domain={wpaDomain}
                tickFormatter={(value) => formatPercent(value)}
                stroke="#f59e0b"
              />

              <ReferenceLine yAxisId="winProb" y={0.5} stroke="#64748b" strokeDasharray="4 4" />
              <ReferenceLine yAxisId="wpa" y={0} stroke="#f59e0b" strokeDasharray="2 2" />

              <Tooltip
                contentStyle={{
                  backgroundColor: "#121826",
                  border: "1px solid #273147",
                  borderRadius: "0.75rem",
                }}
                formatter={(value, name) => {
                  const numericValue =
                    typeof value === "number" ? value : Number(value ?? 0);
                  if (name === "winProbability") {
                    return [formatPercent(numericValue), "Team Win Prob"];
                  }
                  return [formatPercent(numericValue), "Your Cumulative WPA"];
                }}
                labelFormatter={(label) => `Minute ${label}`}
              />

              <Area
                yAxisId="winProb"
                type="monotone"
                dataKey="winProbability"
                stroke="#60a5fa"
                strokeWidth={2}
                fill="url(#wpaWinProbGradient)"
                dot={false}
                isAnimationActive={false}
              />

              <Line
                yAxisId="wpa"
                type="monotone"
                dataKey="cumulativeWPA"
                stroke="#f59e0b"
                strokeWidth={2.4}
                dot={false}
                isAnimationActive={false}
              />

              {keyEvents.map((event) => {
                const minute = Math.floor(event.timestamp / 60_000);
                const y = wpaByMinute.get(minute) ?? cumulativeAtMinute(sortedWpaTimeline, minute);
                const positive = event.delta >= 0;
                return (
                  <ReferenceDot
                    key={event.eventId}
                    yAxisId="wpa"
                    x={minute}
                    y={y}
                    r={Math.max(4, Math.min(9, 4 + Math.abs(event.delta) * 30))}
                    fill={positive ? "#f59e0b" : "#ef4444"}
                    stroke="#0a0e14"
                    strokeWidth={2}
                    ifOverflow="extendDomain"
                    onClick={() => onEventClick?.(event)}
                  >
                    <title>
                      {`${formatTimestamp(event.timestamp)} ${event.type}: ${formatPercent(event.delta)}`}
                    </title>
                  </ReferenceDot>
                );
              })}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
