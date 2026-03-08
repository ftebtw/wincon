import Image from "next/image";
import Link from "next/link";

import { getChampionIconUrl, getItemIconUrl } from "@/lib/data-dragon";
import type { MatchSummary } from "@/lib/types/player";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

export interface MatchCardProps {
  match: MatchSummary;
  playerPuuid: string;
}

const ROLE_LABELS: Record<string, string> = {
  TOP: "T",
  JUNGLE: "J",
  MID: "M",
  ADC: "A",
  SUPPORT: "S",
  UNKNOWN: "?",
};

function formatGameDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatRelativeTime(timestampMs: number): string {
  const elapsedMs = Date.now() - timestampMs;
  const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));
  const elapsedHours = Math.floor(elapsedMs / (60 * 60 * 1000));
  const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));

  if (elapsedMinutes < 1) {
    return "Just now";
  }

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"} ago`;
  }

  if (elapsedHours < 24) {
    return `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} ago`;
  }

  if (elapsedDays === 1) {
    return "Yesterday";
  }

  return `${elapsedDays} days ago`;
}

function getKdaRatio(match: MatchSummary): number {
  if (match.deaths === 0) {
    return match.kills + match.assists;
  }

  return (match.kills + match.assists) / match.deaths;
}

export function MatchCard({ match, playerPuuid }: MatchCardProps) {
  const kdaRatio = getKdaRatio(match);
  const kdaColor =
    kdaRatio > 3
      ? "text-[#10b981]"
      : kdaRatio >= 2
        ? "text-[#f59e0b]"
        : "text-[#ef4444]";

  const nonTrinketItems = match.items.slice(0, 6);
  const trinketItem = match.items[6];

  return (
    <Link
      href={`/match/${encodeURIComponent(match.matchId)}?player=${encodeURIComponent(playerPuuid)}`}
      className="block"
    >
      <Card
        className={cn(
          "border-border/70 bg-card/90 p-4 transition-colors hover:border-primary/70",
          "border-l-4",
          match.win ? "border-l-[#10b981]" : "border-l-[#ef4444]",
        )}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="relative">
              <Image
                src={getChampionIconUrl(match.champion)}
                alt={match.champion}
                width={48}
                height={48}
                className="size-12 rounded-md border border-border/60"
              />
              <span className="absolute -bottom-2 -right-2 inline-flex size-5 items-center justify-center rounded-full border border-border bg-card text-[10px] font-semibold text-foreground">
                {ROLE_LABELS[match.role] ?? "?"}
              </span>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">
                {match.champion} <span className="text-muted-foreground">({match.role})</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {match.win ? "Victory" : "Defeat"} - {formatRelativeTime(match.gameStartTimestamp)}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <div className="text-sm">
              <p className={cn("font-semibold", kdaColor)}>
                {match.kills}/{match.deaths}/{match.assists} ({kdaRatio.toFixed(2)} KDA)
              </p>
              <p className="text-xs text-muted-foreground">
                CS {match.cs} - {(match.cs / Math.max(match.gameDuration / 60, 1)).toFixed(1)} CS/min
              </p>
            </div>

            <div className="flex items-center gap-1">
              {nonTrinketItems.map((itemId, index) => (
                <div
                  key={`${match.matchId}-item-${index}`}
                  className={cn(
                    "size-7 overflow-hidden rounded border border-border/60 bg-background",
                    index >= 4 && "hidden sm:block",
                  )}
                >
                  {itemId > 0 ? (
                    <Image
                      src={getItemIconUrl(itemId)}
                      alt={`Item ${itemId}`}
                      width={28}
                      height={28}
                      className="size-7"
                    />
                  ) : null}
                </div>
              ))}
              <div className="ml-1 hidden size-7 overflow-hidden rounded border border-border/60 bg-background sm:block">
                {trinketItem > 0 ? (
                  <Image
                    src={getItemIconUrl(trinketItem)}
                    alt={`Trinket ${trinketItem}`}
                    width={28}
                    height={28}
                    className="size-7"
                  />
                ) : null}
              </div>
            </div>

            <div className="text-xs text-muted-foreground">
              {formatGameDuration(match.gameDuration)}
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}
