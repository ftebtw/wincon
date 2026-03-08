"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorCard } from "@/components/ErrorCard";
import { PatternAlert } from "@/components/PatternAlert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PatternAnalysisOutput } from "@/lib/types/analysis";
import type { GameSummary, StatPattern } from "@/lib/pattern-detector";

type PatternsApiResponse = {
  statisticalPatterns: StatPattern[];
  aiAnalysis: PatternAnalysisOutput;
  recentGames: GameSummary[];
  generatedAt: string;
  cached: boolean;
};

type PatternsSectionProps = {
  puuid: string;
};

type PatternsError = {
  message: string;
  status?: number;
  retryAfter?: number;
};

function inferPatternType(patternName: string, fallbackType?: string): string {
  if (fallbackType) {
    return fallbackType;
  }

  const normalized = patternName.toLowerCase();
  if (normalized.includes("death") || normalized.includes("gank")) {
    return "early_death";
  }
  if (normalized.includes("vision") || normalized.includes("ward")) {
    return "vision";
  }
  if (normalized.includes("cs") || normalized.includes("farm")) {
    return "cs";
  }
  if (normalized.includes("build") || normalized.includes("item")) {
    return "build";
  }
  if (
    normalized.includes("objective") ||
    normalized.includes("dragon") ||
    normalized.includes("baron")
  ) {
    return "objective";
  }

  return "general";
}

export function PatternsSection({ puuid }: PatternsSectionProps) {
  const [data, setData] = useState<PatternsApiResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [processedGames, setProcessedGames] = useState(0);
  const [error, setError] = useState<PatternsError | null>(null);

  useEffect(() => {
    if (!isLoading) {
      setProcessedGames(0);
      return;
    }

    const interval = window.setInterval(() => {
      setProcessedGames((previous) => Math.min(20, previous + 1));
    }, 180);

    return () => {
      window.clearInterval(interval);
    };
  }, [isLoading]);

  async function analyzePatterns() {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/patterns/${encodeURIComponent(puuid)}`, {
        method: "GET",
        cache: "no-store",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          retryAfter?: number;
        };
        setError({
          status: response.status,
          message: payload.error ?? "Failed to analyze patterns.",
          retryAfter: payload.retryAfter,
        });
        return;
      }

      const payload = (await response.json()) as PatternsApiResponse;
      setData(payload);
      setProcessedGames(20);
    } catch (analyzeError) {
      const message =
        analyzeError instanceof Error ? analyzeError.message : "Failed to analyze patterns.";
      setError({ message });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="text-lg">Patterns</CardTitle>
            <p className="text-sm text-muted-foreground">
              Analyze your recent games to find recurring mistakes.
            </p>
          </div>
          <Button onClick={analyzePatterns} disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 size-4" />
                Analyze My Patterns
              </>
            )}
          </Button>
        </CardHeader>

        {isLoading ? (
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">Analyzing your last 20 games...</p>
            <div className="h-2 rounded-full bg-border/60">
              <div
                className="h-2 rounded-full bg-primary transition-all"
                style={{ width: `${Math.max(5, (processedGames / 20) * 100)}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">{processedGames}/20 games processed</p>
          </CardContent>
        ) : null}

        {error ? (
          <CardContent>
            <ErrorCard
              title="Pattern Analysis Unavailable"
              statusCode={error.status}
              description={error.message}
              retryAfterSeconds={error.retryAfter}
              onRetry={analyzePatterns}
              retryLabel="Retry analysis"
            />
          </CardContent>
        ) : null}
      </Card>

      {data ? (
        <>
          <div className="space-y-3">
            {data.aiAnalysis.patterns.length > 0 ? (
              data.aiAnalysis.patterns.map((pattern, index) => (
                <PatternAlert
                  key={`${pattern.pattern_name}-${index}`}
                  pattern={pattern}
                  type={inferPatternType(pattern.pattern_name, data.statisticalPatterns[index]?.type)}
                />
              ))
            ) : (
              <Card>
                <CardContent className="py-5 text-sm text-muted-foreground">
                  No strong recurring patterns were detected in the sampled games.
                </CardContent>
              </Card>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Your Coaching Plan</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{data.aiAnalysis.overall_coaching_plan}</p>
              <p className="text-xs text-muted-foreground">
                {data.cached ? "Loaded from cache" : "Fresh analysis"} · {data.recentGames.length} games
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
