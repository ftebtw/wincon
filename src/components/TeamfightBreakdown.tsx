import Image from "next/image";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getChampionIconUrl } from "@/lib/data-dragon";
import type { Teamfight } from "@/lib/play-by-play";
import { cn } from "@/lib/utils";

export interface TeamfightBreakdownProps {
  teamfight: Teamfight;
  playerChampion: string;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function signedPercent(value: number): string {
  const pct = Math.round(value * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

export function TeamfightBreakdown({
  teamfight,
  playerChampion,
}: TeamfightBreakdownProps) {
  const isPositive = teamfight.wpaDelta >= 0;
  const highlightError =
    teamfight.playerPerformance.positioning === "bad" ||
    teamfight.playerPerformance.deaths > 0;
  const outcomeLabel =
    teamfight.winner === "trade"
      ? "Trade"
      : isPositive
        ? "Your team WON"
        : "Your team LOST";

  return (
    <Card
      id={teamfight.id}
      className={cn(
        "border-border/70",
        highlightError ? "border-[#ef4444]/50" : isPositive ? "border-[#10b981]/40" : "",
      )}
    >
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            Teamfight at {formatTimestamp(teamfight.startTime)} - {outcomeLabel}
          </CardTitle>
          <Badge className={cn(isPositive ? "bg-[#10b981]" : "bg-[#ef4444]")}>
            {signedPercent(teamfight.wpaDelta)} WPA
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Initiated by {teamfight.initiator}. Kill score: Blue {teamfight.blueKills} - Red{" "}
          {teamfight.redKills}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <div className="flex min-w-max items-center gap-2 rounded-md border border-border/70 bg-background/30 p-2">
            {teamfight.killOrder.map((kill, index) => (
              <div
                key={`${kill.timestamp}-${kill.victim}-${kill.killer}-${index}`}
                className="flex items-center gap-2"
              >
                <div className="rounded-md border border-border/70 bg-background/70 p-1">
                  <Image
                    src={getChampionIconUrl(kill.victim)}
                    alt={kill.victim}
                    width={24}
                    height={24}
                    className="size-6 rounded-sm"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {kill.killer} {"->"} {kill.victim} ({formatTimestamp(kill.timestamp)})
                </p>
                {index < teamfight.killOrder.length - 1 ? (
                  <span className="px-1 text-muted-foreground">|</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-border/70 bg-background/30 p-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{playerChampion}:</span>{" "}
            {teamfight.playerPerformance.kills}/{teamfight.playerPerformance.deaths}/
            {teamfight.playerPerformance.assists}{" "}
            {teamfight.playerPerformance.survived ? "survived" : "died"}.
            Positioning judged as{" "}
            <span
              className={cn(
                "font-semibold",
                teamfight.playerPerformance.positioning === "good" && "text-[#10b981]",
                teamfight.playerPerformance.positioning === "bad" && "text-[#ef4444]",
              )}
            >
              {teamfight.playerPerformance.positioning}
            </span>
            .
          </p>
          {teamfight.objectiveAfter ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Objective converted: {teamfight.objectiveAfter}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
