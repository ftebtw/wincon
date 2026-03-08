import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RankBenchmarks } from "@/lib/rank-benchmarks";
import { cn } from "@/lib/utils";

export interface RankBenchmarkBarsProps {
  benchmarks: RankBenchmarks;
  multiRank?: {
    playerTier: RankBenchmarks;
    oneTierUp: RankBenchmarks;
    challenger: RankBenchmarks;
  };
}

type MetricKey = keyof RankBenchmarks;

const METRIC_CONFIG: Array<{
  key: MetricKey;
  label: string;
  highIsBetter: boolean;
}> = [
  { key: "csAt10", label: "CS@10", highIsBetter: true },
  { key: "goldAt10", label: "Gold@10", highIsBetter: true },
  { key: "visionScore", label: "Vision", highIsBetter: true },
  { key: "deathsBefore10", label: "Deaths <10", highIsBetter: false },
  { key: "damageShare", label: "Damage Share", highIsBetter: true },
  { key: "kda", label: "KDA", highIsBetter: true },
  { key: "csPerMin", label: "CS/min", highIsBetter: true },
];

function valueLabel(value: number, key: MetricKey): string {
  if (key === "damageShare") {
    return `${Math.round(value * 100)}%`;
  }
  if (key === "goldAt10") {
    return `${Math.round(value)}`;
  }
  return Number(value.toFixed(2)).toString();
}

export function RankBenchmarkBars({
  benchmarks,
  multiRank,
}: RankBenchmarkBarsProps) {
  return (
    <Card className="border-border/70">
      <CardHeader>
        <CardTitle>How You Compare To Your Rank</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {METRIC_CONFIG.map((metric) => {
          const playerMetric = benchmarks[metric.key];
          const targetMetric = multiRank?.oneTierUp[metric.key] ?? playerMetric;
          const ceilingMetric = multiRank?.challenger[metric.key] ?? targetMetric;

          const maxReference = Math.max(
            playerMetric.player,
            playerMetric.rankAvg,
            targetMetric.rankAvg,
            ceilingMetric.rankAvg,
            1,
          );
          const playerWidth = Math.min(100, Math.max(4, (playerMetric.player / maxReference) * 100));
          const avgWidth = Math.min(100, Math.max(4, (playerMetric.rankAvg / maxReference) * 100));
          const targetWidth = Math.min(100, Math.max(4, (targetMetric.rankAvg / maxReference) * 100));
          const playerBetter = metric.highIsBetter
            ? playerMetric.player >= playerMetric.rankAvg
            : playerMetric.player <= playerMetric.rankAvg;

          return (
            <div key={metric.key} className="rounded-md border border-border/70 bg-background/30 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-foreground">
                  {metric.label}: {valueLabel(playerMetric.player, metric.key)}
                </p>
                <Badge
                  variant="outline"
                  className={cn(
                    playerBetter ? "border-[#10b981]/60 text-[#34d399]" : "border-[#ef4444]/60 text-[#fca5a5]",
                  )}
                >
                  Top {playerMetric.percentile}% for rank
                </Badge>
              </div>

              <div className="relative h-3 rounded-full bg-border/50">
                <div
                  className={cn(
                    "h-3 rounded-full",
                    playerBetter ? "bg-[#10b981]" : "bg-[#ef4444]",
                  )}
                  style={{ width: `${playerWidth}%` }}
                />
                <div
                  className="absolute top-0 h-3 w-1 rounded-sm bg-muted-foreground"
                  style={{ left: `${avgWidth}%` }}
                  title={`Rank avg: ${valueLabel(playerMetric.rankAvg, metric.key)}`}
                />
                <div
                  className="absolute top-0 h-3 w-1 rounded-sm bg-primary"
                  style={{ left: `${targetWidth}%` }}
                  title={`Next tier target: ${valueLabel(targetMetric.rankAvg, metric.key)}`}
                />
              </div>

              <p className="mt-2 text-xs text-muted-foreground">
                Rank avg {valueLabel(playerMetric.rankAvg, metric.key)} | Next tier target{" "}
                {valueLabel(targetMetric.rankAvg, metric.key)} | Challenger{" "}
                {valueLabel(ceilingMetric.rankAvg, metric.key)}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

