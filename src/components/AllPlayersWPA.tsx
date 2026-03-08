import { Trophy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PlayerWPASummary } from "@/lib/wpa-engine";
import { cn } from "@/lib/utils";

export interface AllPlayersWPAProps {
  summaries: PlayerWPASummary[];
  playerPuuid: string;
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

function formatWpa(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}% WPA`;
}

export function AllPlayersWPA({ summaries, playerPuuid }: AllPlayersWPAProps) {
  const ranked = [...summaries].sort((a, b) => a.rank - b.rank);
  const maxAbs = Math.max(0.01, ...ranked.map((summary) => Math.abs(summary.totalWPA)));

  return (
    <Card className="border-border/70">
      <CardHeader>
        <CardTitle>All Players WPA</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {ranked.map((summary, index) => {
          const isPlayer = summary.puuid === playerPuuid;
          const isMvp = index === 0;
          const barWidth = Math.max(4, (Math.abs(summary.totalWPA) / maxAbs) * 100);
          const isBlue = summary.teamId === 100;
          return (
            <div
              key={summary.puuid}
              className={cn(
                "rounded-md border border-border/60 p-2",
                isBlue ? "bg-[#3b82f6]/8" : "bg-[#ef4444]/8",
                isPlayer && "border-primary ring-1 ring-primary/60",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-8 shrink-0 text-xs font-semibold text-muted-foreground">
                    {ordinal(summary.rank)}
                  </span>
                  {isMvp ? <Trophy className="size-4 text-[#fbbf24]" /> : null}
                  <p className="truncate text-sm font-semibold text-foreground">
                    {summary.champion} ({summary.role})
                    {isPlayer ? " \u2190 YOU" : ""}
                  </p>
                </div>
                <Badge
                  className={cn(
                    summary.totalWPA >= 0
                      ? "bg-[#10b981] text-black"
                      : "bg-[#ef4444] text-white",
                  )}
                >
                  {formatWpa(summary.totalWPA)}
                </Badge>
              </div>
              <div className="mt-2 h-2 rounded-full bg-background/60">
                <div
                  className={cn(
                    "h-2 rounded-full",
                    summary.totalWPA >= 0 ? "bg-[#10b981]" : "bg-[#ef4444]",
                  )}
                  style={{ width: `${barWidth}%` }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
