"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { EsportsEvent } from "@/lib/esports-api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface UpcomingMatchesProps {
  matches: EsportsEvent[];
}

function countdownLabel(startTime: string, now: number): string {
  const target = Date.parse(startTime);
  if (!Number.isFinite(target)) {
    return "Time TBD";
  }

  const diff = target - now;
  if (diff <= 0) {
    return "Starting soon";
  }

  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `Starts in ${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `Starts in ${hours}h ${minutes}m`;
  }

  return `Starts in ${minutes}m`;
}

function watchUrl(eventId: string): string {
  return `https://lolesports.com/en-US/schedule?eventId=${encodeURIComponent(eventId)}`;
}

export function UpcomingMatches({ matches }: UpcomingMatchesProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const normalizedMatches = useMemo(
    () =>
      [...matches]
        .filter((event) => event.state === "unstarted")
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
        .slice(0, 5),
    [matches],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upcoming Matches</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {normalizedMatches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No upcoming matches currently listed.</p>
        ) : null}

        {normalizedMatches.map((event) => {
          const teams = event.match?.teams ?? [];
          const left = teams[0];
          const right = teams[1];

          return (
            <div
              key={event.id}
              className="rounded-md border border-border/60 bg-background/40 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant="outline">{event.league.slug.toUpperCase()}</Badge>
                <p className="text-xs text-muted-foreground">{countdownLabel(event.startTime, now)}</p>
              </div>

              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {left?.image ? (
                    <Image
                      src={left.image}
                      alt={left.name}
                      width={26}
                      height={26}
                      className="size-6 rounded-sm object-contain"
                    />
                  ) : null}
                  <span className="text-sm font-medium text-foreground">{left?.code || left?.name || "TBD"}</span>
                </div>
                <span className="text-xs text-muted-foreground">vs</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{right?.code || right?.name || "TBD"}</span>
                  {right?.image ? (
                    <Image
                      src={right.image}
                      alt={right.name}
                      width={26}
                      height={26}
                      className="size-6 rounded-sm object-contain"
                    />
                  ) : null}
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  {event.startTime
                    ? new Date(event.startTime).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "TBD"}
                </span>
                <Link
                  href={watchUrl(event.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Watch
                </Link>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
