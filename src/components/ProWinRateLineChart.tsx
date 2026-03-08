"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type TrendPoint = {
  bucket: string;
  winRate: number;
  games: number;
};

type ProWinRateLineChartProps = {
  data: TrendPoint[];
};

export function ProWinRateLineChart({ data }: ProWinRateLineChartProps) {
  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(148, 163, 184, 0.2)" strokeDasharray="4 4" />
          <XAxis dataKey="bucket" tick={{ fill: "#94a3b8", fontSize: 12 }} />
          <YAxis
            domain={[0, 1]}
            tick={{ fill: "#94a3b8", fontSize: 12 }}
            tickFormatter={(value) => `${Math.round(value * 100)}%`}
          />
          <Tooltip
            formatter={(value, _name, payload) => {
              const numericValue = Number(value ?? 0);
              const games =
                payload && typeof payload === "object" && "payload" in payload
                  ? Number((payload as { payload?: { games?: number } }).payload?.games ?? 0)
                  : 0;

              return [`${Math.round(numericValue * 100)}%`, `${games} games`];
            }}
            labelFormatter={(label) => `Period: ${label}`}
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid rgba(148, 163, 184, 0.3)",
              color: "#e2e8f0",
            }}
          />
          <Line
            type="monotone"
            dataKey="winRate"
            stroke="#3b82f6"
            strokeWidth={2.5}
            dot={{ r: 3, fill: "#60a5fa" }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
