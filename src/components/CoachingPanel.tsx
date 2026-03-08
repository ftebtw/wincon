"use client";

import Image from "next/image";
import { Brain } from "lucide-react";
import { useMemo } from "react";
import useSWR from "swr";

import { ErrorCard } from "@/components/ErrorCard";
import { KeyMomentCard } from "@/components/KeyMomentCard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getItemIconUrl } from "@/lib/data-dragon";
import type { MatchAnalysisOutput } from "@/lib/types/analysis";
import type { KeyMoment } from "@/lib/win-probability";
import { cn } from "@/lib/utils";

type CoachingPanelProps = {
  matchId: string;
  playerPuuid: string;
  keyMoments: Array<KeyMoment & { context?: string }>;
};

type AnalysisFetchError = {
  status?: number;
  message: string;
  retryAfter?: number;
};

const ITEM_NAME_TO_ID: Record<string, number> = {
  morellonomicon: 3165,
  thornmail: 3075,
  "mortal reminder": 3033,
  chempunk: 6609,
  "guardian angel": 3026,
  "zhonya": 3157,
  "banshee": 3102,
  "force of nature": 4401,
  "randuin": 3143,
  "kaenic rookern": 2504,
  "abyssal mask": 8020,
  "mercury": 3111,
  "plated steelcaps": 3047,
  "quicksilver sash": 3140,
  "maw of malmortius": 3156,
  "jak'sho": 6665,
};

function parseTimestampToSeconds(timestamp: string): number | null {
  const [minutes, seconds] = timestamp.split(":");
  const minuteValue = Number(minutes);
  const secondValue = Number(seconds);

  if (!Number.isFinite(minuteValue) || !Number.isFinite(secondValue)) {
    return null;
  }

  return minuteValue * 60 + secondValue;
}

function findItemIconId(suggestion: string): number | null {
  const normalized = suggestion.toLowerCase();
  for (const [key, itemId] of Object.entries(ITEM_NAME_TO_ID)) {
    if (normalized.includes(key)) {
      return itemId;
    }
  }

  return null;
}

function gradeClass(grade: MatchAnalysisOutput["overall_grade"]): string {
  switch (grade) {
    case "A":
      return "bg-[#10b981] text-black";
    case "B":
      return "bg-[#3b82f6] text-white";
    case "C":
      return "bg-[#f59e0b] text-black";
    case "D":
      return "bg-[#f97316] text-black";
    case "F":
      return "bg-[#ef4444] text-white";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function buildRatingClass(rating: MatchAnalysisOutput["build_analysis"]["rating"]): string {
  if (rating === "optimal") {
    return "bg-[#10b981] text-black";
  }

  if (rating === "poor") {
    return "bg-[#ef4444] text-white";
  }

  return "bg-[#f59e0b] text-black";
}

export function CoachingPanel({ matchId, playerPuuid, keyMoments }: CoachingPanelProps) {
  const key = `/api/analysis/${encodeURIComponent(matchId)}?player=${encodeURIComponent(playerPuuid)}`;
  const { data: analysis, isLoading, error, mutate } = useSWR<MatchAnalysisOutput, AnalysisFetchError>(
    key,
    async (url: string) => {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          retryAfter?: number;
        };

        throw {
          status: response.status,
          message: payload.error ?? "Failed to load AI coaching.",
          retryAfter: payload.retryAfter,
        } satisfies AnalysisFetchError;
      }

      return (await response.json()) as MatchAnalysisOutput;
    },
    {
      revalidateOnFocus: true,
    },
  );

  const aiMomentsByTimestamp = useMemo(() => {
    const map = new Map<number, MatchAnalysisOutput["key_moments"][number]>();
    if (!analysis) {
      return map;
    }

    const candidates = analysis.key_moments.map((moment, index) => ({
      index,
      moment,
      seconds: parseTimestampToSeconds(moment.timestamp),
    }));
    const used = new Set<number>();

    for (const moment of keyMoments) {
      const targetSeconds = Math.floor(moment.timestamp / 1000);
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const candidate of candidates) {
        if (used.has(candidate.index) || candidate.seconds === null) {
          continue;
        }

        const distance = Math.abs(candidate.seconds - targetSeconds);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = candidate.index;
        }
      }

      if (bestIndex >= 0 && bestDistance <= 90) {
        used.add(bestIndex);
        map.set(moment.timestamp, candidates[bestIndex].moment);
      }
    }

    return map;
  }, [analysis, keyMoments]);

  const keyMomentsChronological = useMemo(
    () => [...keyMoments].sort((a, b) => a.timestamp - b.timestamp),
    [keyMoments],
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>AI Coaching</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="flex items-center gap-3 rounded-md border border-border/70 bg-background/40 p-4">
              <Brain className="size-5 animate-pulse text-primary" />
              <div>
                <p className="text-sm text-muted-foreground">AI is analyzing your game...</p>
                <p className="text-xs text-muted-foreground">Estimated wait: 5-10 seconds</p>
              </div>
            </div>
          ) : null}

          {error ? (
            <ErrorCard
              statusCode={error.status}
              title="AI coaching is temporarily unavailable."
              description="You can still see the stats and graphs."
              retryAfterSeconds={error.retryAfter}
              onRetry={() => mutate()}
              retryLabel="Retry AI analysis"
            />
          ) : null}

          {analysis ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Badge className={cn("text-lg font-bold", gradeClass(analysis.overall_grade))}>
                  {analysis.overall_grade}
                </Badge>
                <p className="text-sm text-muted-foreground">{analysis.summary}</p>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-semibold text-foreground">Top 3 Improvements</p>
                <div className="grid gap-2 md:grid-cols-3">
                  {analysis.top_3_improvements.map((improvement, index) => (
                    <div
                      key={`${improvement}-${index}`}
                      className="rounded-md border border-border/70 bg-background/40 p-3"
                    >
                      <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                        {index + 1}. Priority
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">{improvement}</p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Key Moments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {keyMomentsChronological.map((moment) => (
            <KeyMomentCard
              key={moment.timestamp}
              moment={moment}
              aiMoment={aiMomentsByTimestamp.get(moment.timestamp)}
            />
          ))}
        </CardContent>
      </Card>

      {analysis ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Build Analysis</CardTitle>
              <Badge className={buildRatingClass(analysis.build_analysis.rating)}>
                {analysis.build_analysis.rating}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{analysis.build_analysis.explanation}</p>
            {analysis.build_analysis.what_they_built_well ? (
              <div className="rounded-md border border-[#10b981]/40 bg-[#10b981]/10 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#34d399]">
                  What You Built Well
                </p>
                <p className="mt-1 text-sm text-[#a7f3d0]">
                  {analysis.build_analysis.what_they_built_well}
                </p>
              </div>
            ) : null}

            <div className="space-y-2">
              <p className="text-sm font-semibold text-foreground">Suggested Changes</p>
              <ul className="space-y-2">
                {analysis.build_analysis.suggested_changes.map((suggestion, index) => {
                  const itemId = findItemIconId(suggestion);
                  return (
                    <li
                      key={`${suggestion}-${index}`}
                      className="flex items-start gap-3 rounded-md border border-border/70 bg-background/30 p-3 text-sm text-muted-foreground"
                    >
                      {itemId ? (
                        <Image
                          src={getItemIconUrl(itemId)}
                          alt={`Item ${itemId}`}
                          width={24}
                          height={24}
                          className="mt-0.5 size-6 rounded border border-border/60"
                        />
                      ) : (
                        <span className="mt-1 inline-block size-2 rounded-full bg-primary" />
                      )}
                      <span>{suggestion}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {analysis ? (
        <Card>
          <CardHeader>
            <CardTitle>Laning and Macro</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <details className="rounded-md border border-border/70 bg-background/30 p-3" open>
              <summary className="cursor-pointer text-sm font-semibold text-foreground">
                Laning Phase
              </summary>
              <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">CS:</span>{" "}
                  {analysis.laning_phase.cs_assessment}
                </p>
                <p>
                  <span className="font-medium text-foreground">Trade Patterns:</span>{" "}
                  {analysis.laning_phase.trade_patterns}
                </p>
                <ul className="space-y-1">
                  {analysis.laning_phase.tips.map((tip, index) => (
                    <li key={`${tip}-${index}`}>- {tip}</li>
                  ))}
                </ul>
              </div>
            </details>

            <details className="rounded-md border border-border/70 bg-background/30 p-3" open>
              <summary className="cursor-pointer text-sm font-semibold text-foreground">
                Macro Assessment
              </summary>
              <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">Objectives:</span>{" "}
                  {analysis.macro_assessment.objective_participation}
                </p>
                <p>
                  <span className="font-medium text-foreground">Map Presence:</span>{" "}
                  {analysis.macro_assessment.map_presence}
                </p>
                <ul className="space-y-1">
                  {analysis.macro_assessment.tips.map((tip, index) => (
                    <li key={`${tip}-${index}`}>- {tip}</li>
                  ))}
                </ul>
              </div>
            </details>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
