import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PlayerWPASummary } from "@/lib/wpa-engine";
import { cn } from "@/lib/utils";

export interface PlayerContributionCardProps {
  summary: PlayerWPASummary;
  totalPlayers: number;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatWpa(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  const mod10 = value % 10;
  if (mod10 === 1) return `${value}st`;
  if (mod10 === 2) return `${value}nd`;
  if (mod10 === 3) return `${value}rd`;
  return `${value}th`;
}

export function PlayerContributionCard({
  summary,
  totalPlayers,
}: PlayerContributionCardProps) {
  const positive = Math.max(0, summary.positiveWPA);
  const negativeAbs = Math.abs(Math.min(0, summary.negativeWPA));
  const totalMagnitude = Math.max(positive + negativeAbs, 0.001);
  const positiveWidth = (positive / totalMagnitude) * 100;
  const negativeWidth = (negativeAbs / totalMagnitude) * 100;

  const contributionText =
    summary.rank <= 3
      ? `You were the ${ordinal(summary.rank)} most impactful player this game.`
      : `You finished ${ordinal(summary.rank)} of ${totalPlayers} in match impact.`;

  const bestPlayDelta = summary.biggestPositivePlay.attributions
    .filter((entry) => entry.puuid === summary.puuid)
    .reduce((sum, entry) => sum + entry.wpaValue, 0);
  const worstPlayDelta = summary.biggestNegativePlay.attributions
    .filter((entry) => entry.puuid === summary.puuid)
    .reduce((sum, entry) => sum + entry.wpaValue, 0);

  return (
    <Card className="border-border/70">
      <CardHeader>
        <CardTitle>Your Contribution</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Total WPA:</span>
            <Badge
              className={cn(
                summary.totalWPA >= 0 ? "bg-[#10b981] text-black" : "bg-[#ef4444] text-white",
              )}
            >
              {formatWpa(summary.totalWPA)}
            </Badge>
          </div>
          <p className="text-sm font-semibold text-foreground">
            Rank: {ordinal(summary.rank)}/{totalPlayers}
          </p>
        </div>

        <div className="overflow-hidden rounded-full border border-border/70">
          <div className="flex h-3 w-full bg-background/50">
            <div
              className="h-full bg-[#10b981]"
              style={{ width: `${positiveWidth}%` }}
              title={`Positive WPA ${formatWpa(summary.positiveWPA)}`}
            />
            <div
              className="h-full bg-[#ef4444]"
              style={{ width: `${negativeWidth}%` }}
              title={`Negative WPA ${formatWpa(summary.negativeWPA)}`}
            />
          </div>
        </div>

        <div className="space-y-2 rounded-md border border-border/70 bg-background/30 p-3">
          <p className="text-sm text-[#10b981]">
            Best play: {summary.biggestPositivePlay.type} at{" "}
            {formatTimestamp(summary.biggestPositivePlay.timestamp)} ({formatWpa(bestPlayDelta)})
          </p>
          <p className="text-sm text-[#ef4444]">
            Worst play: {summary.biggestNegativePlay.type} at{" "}
            {formatTimestamp(summary.biggestNegativePlay.timestamp)} ({formatWpa(worstPlayDelta)})
          </p>
        </div>

        <p className="text-sm text-muted-foreground">{contributionText}</p>
      </CardContent>
    </Card>
  );
}

