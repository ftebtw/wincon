"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect } from "react";

import type { EsportsEvent, EsportsLiveGame } from "@/lib/esports-api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface LiveProMatchProps {
  event: EsportsEvent;
  game?: EsportsLiveGame;
  onRefresh?: () => void;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatGold(gold: number): string {
  if (gold >= 1000) {
    return `${(gold / 1000).toFixed(1)}k`;
  }
  return String(gold);
}

function calculateGoldPct(game?: EsportsLiveGame): number {
  if (!game || game.teams.length < 2) {
    return 50;
  }

  const blueGold = game.teams[0]?.gold ?? 0;
  const redGold = game.teams[1]?.gold ?? 0;
  const total = blueGold + redGold;

  if (total <= 0) {
    return 50;
  }

  return Math.max(0, Math.min(100, (blueGold / total) * 100));
}

function watchUrl(eventId: string): string {
  return `https://lolesports.com/en-US/schedule?eventId=${encodeURIComponent(eventId)}`;
}

export function LiveProMatch({ event, game, onRefresh }: LiveProMatchProps) {
  useEffect(() => {
    if (!onRefresh) {
      return;
    }

    const interval = window.setInterval(() => {
      onRefresh();
    }, 30_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [onRefresh]);

  const teams = event.match?.teams ?? [];
  const blue = teams[0];
  const red = teams[1];
  const blueSeries = blue?.result?.gameWins ?? 0;
  const redSeries = red?.result?.gameWins ?? 0;
  const goldPct = calculateGoldPct(game);

  return (
    <Card className="border-[#ef4444]/40 bg-[#ef4444]/10">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <span className="relative inline-flex size-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#ef4444] opacity-75" />
              <span className="relative inline-flex size-2.5 rounded-full bg-[#ef4444]" />
            </span>
            LIVE NOW - {event.league.name || event.league.slug.toUpperCase()}
          </CardTitle>
          <Badge variant="outline">{event.blockName || "Live Match"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <div className="flex items-center gap-2">
            {blue?.image ? (
              <Image
                src={blue.image}
                alt={blue.name}
                width={34}
                height={34}
                className="size-8 rounded-sm object-contain"
              />
            ) : null}
            <span className="text-sm font-semibold text-foreground">{blue?.name ?? "TBD"}</span>
          </div>

          <div className="text-center text-sm font-semibold text-foreground">
            {blueSeries} - {redSeries}
          </div>

          <div className="flex items-center justify-end gap-2">
            <span className="text-sm font-semibold text-foreground">{red?.name ?? "TBD"}</span>
            {red?.image ? (
              <Image
                src={red.image}
                alt={red.name}
                width={34}
                height={34}
                className="size-8 rounded-sm object-contain"
              />
            ) : null}
          </div>
        </div>

        {game ? (
          <>
            <p className="text-xs text-muted-foreground">
              Game {game.number} in progress - {formatClock(game.clock.totalSeconds)}
            </p>

            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <p>
                {game.teams[0]?.code ?? blue?.code ?? "BLUE"}: {game.teams[0]?.kills ?? 0} kills, {formatGold(game.teams[0]?.gold ?? 0)} gold, {game.teams[0]?.towers ?? 0} towers
              </p>
              <p className="sm:text-right">
                {game.teams[1]?.code ?? red?.code ?? "RED"}: {game.teams[1]?.kills ?? 0} kills, {formatGold(game.teams[1]?.gold ?? 0)} gold, {game.teams[1]?.towers ?? 0} towers
              </p>
            </div>

            <div className="h-2 overflow-hidden rounded-full bg-border/60">
              <div className="h-full bg-[#3b82f6]" style={{ width: `${goldPct}%` }} />
            </div>

            <p className="text-xs text-muted-foreground">
              Dragons: {(game.teams[0]?.dragons.length ?? 0)} vs {(game.teams[1]?.dragons.length ?? 0)} | Barons: {game.teams[0]?.barons ?? 0} vs {game.teams[1]?.barons ?? 0}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Live series detected. In-game stats stream not available for this event yet.</p>
        )}

        <div>
          <Link
            href={watchUrl(event.id)}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Watch on lolesports.com {"->"}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
