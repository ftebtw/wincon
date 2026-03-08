"use client";

import { useMemo, useState } from "react";
import { Loader2, Trophy } from "lucide-react";

import type { SimilaritySearchResult } from "@/lib/similarity-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface WhatWouldAProDoProps {
  result: SimilaritySearchResult;
  onMinuteChange?: (minute: number) => void;
  matchId?: string;
  playerPuuid?: string;
}

const MINUTE_PRESETS = [10, 15, 20, 25, 30];

function formatSigned(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatSource(result: SimilaritySearchResult["results"][number]): string {
  const { metadata } = result.gameState;
  if (metadata.isProGame) {
    return [metadata.teamName, metadata.playerName].filter(Boolean).join(" - ") || "Pro game";
  }

  return [metadata.rank, metadata.region].filter(Boolean).join(" - ") || "High elo";
}

export function WhatWouldAProDo({
  result,
  onMinuteChange,
  matchId,
  playerPuuid,
}: WhatWouldAProDoProps) {
  const [current, setCurrent] = useState(result);
  const [loadingMinute, setLoadingMinute] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedMinute = current.query.minute;
  const minuteOptions = useMemo(() => {
    const merged = new Set([...MINUTE_PRESETS, selectedMinute]);
    return Array.from(merged).sort((a, b) => a - b);
  }, [selectedMinute]);

  const requestMinute = async (minute: number) => {
    if (minute === selectedMinute) {
      return;
    }

    setErrorMessage(null);
    onMinuteChange?.(minute);

    if (!matchId || !playerPuuid) {
      return;
    }

    setLoadingMinute(minute);
    try {
      const response = await fetch("/api/similar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          matchId,
          playerPuuid,
          minute,
          options: {
            k: 3,
            sameChampion: true,
            sameRole: true,
          },
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to load similar game states.");
      }

      const payload = (await response.json()) as SimilaritySearchResult;
      setCurrent(payload);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Similarity search failed.");
    } finally {
      setLoadingMinute(null);
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-xl">What Would a Pro Do?</CardTitle>
          <Badge variant="outline">Min {selectedMinute}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {current.query.champion} at {current.query.minute}:00, gold diff{" "}
          {formatSigned(current.query.goldDiff)}. {current.query.situation}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {minuteOptions.map((minute) => (
            <Button
              key={minute}
              type="button"
              variant={minute === selectedMinute ? "default" : "outline"}
              size="sm"
              onClick={() => void requestMinute(minute)}
              disabled={loadingMinute !== null}
            >
              {loadingMinute === minute ? (
                <>
                  <Loader2 className="mr-1 size-4 animate-spin" />
                  {minute}
                </>
              ) : (
                minute
              )}
            </Button>
          ))}
        </div>

        {loadingMinute !== null ? (
          <p className="text-xs text-muted-foreground">
            Searching high-elo and pro games for similar situations...
          </p>
        ) : null}

        {loadingMinute !== null && current.results.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : null}

        {current.results.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/80 p-4 text-sm text-muted-foreground">
            No similar game states were found yet for this champion/role window.
          </div>
        ) : (
          <div className="space-y-3">
            {current.results.map((entry, index) => (
              <div
                key={`${entry.gameState.metadata.matchId}-${entry.gameState.metadata.minute}-${index}`}
                className="rounded-lg border border-border/70 bg-background/40 p-4"
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {entry.gameState.metadata.isProGame ? (
                      <Trophy className="size-4 text-yellow-400" />
                    ) : null}
                    <p className="text-sm font-semibold">{formatSource(entry)}</p>
                  </div>
                  <Badge variant="secondary">{Math.round(entry.similarity * 100)}% match</Badge>
                </div>

                <p className="text-xs text-muted-foreground">
                  {entry.gameState.metadata.playerChampion} {entry.gameState.metadata.playerRole} ·{" "}
                  {entry.gameState.metadata.minute}:00 · {entry.highlightReason}
                </p>

                <p className="mt-2 text-sm">
                  What happened: {entry.gameState.outcome.next5MinEvents}
                </p>

                <p className="mt-2 text-xs text-muted-foreground">
                  Result: {entry.gameState.outcome.wonGame ? "WIN" : "LOSS"} · Gold swing{" "}
                  {formatSigned(entry.gameState.outcome.goldDiffChange5Min)} · WPA{" "}
                  {formatPercent(entry.gameState.outcome.winProbChange)}
                </p>

                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">
                    More detail
                  </summary>
                  <p className="mt-1">
                    Objectives:{" "}
                    {entry.gameState.outcome.objectivesTaken.length > 0
                      ? entry.gameState.outcome.objectivesTaken.join(", ")
                      : "none"}
                    {" | "}Kills Δ {formatSigned(entry.gameState.outcome.killsChange5Min)}
                    {" | "}Towers Δ {formatSigned(entry.gameState.outcome.towersChange5Min)}
                  </p>
                </details>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-300">
            Recommendation
          </p>
          <p className="mt-1 text-sm">{current.aiInsight}</p>
        </div>

        {errorMessage ? (
          <p className="text-sm text-red-400">{errorMessage}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
