"use client";

import Image from "next/image";
import Link from "next/link";
import useSWR from "swr";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getChampionIconUrl } from "@/lib/data-dragon";
import type { MatchupGuide } from "@/lib/matchup-guide";

type MatchupGuideClientProps = {
  matchupId: string;
};

type ApiError = {
  error: string;
};

const fetcher = async (url: string): Promise<MatchupGuide> => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || "Failed to load matchup guide.");
  }
  return (await response.json()) as MatchupGuide;
};

function difficultyBadgeClass(difficulty: "easy" | "medium" | "hard"): string {
  if (difficulty === "easy") return "bg-[#10b981] text-black";
  if (difficulty === "hard") return "bg-[#ef4444] text-white";
  return "bg-[#f59e0b] text-black";
}

function winRateColor(winRate: number): string {
  if (winRate >= 0.52) return "text-[#10b981]";
  if (winRate <= 0.48) return "text-[#ef4444]";
  return "text-[#f59e0b]";
}

export function MatchupGuideClient({ matchupId }: MatchupGuideClientProps) {
  const {
    data: guide,
    error,
    isLoading,
  } = useSWR<MatchupGuide>(
    `/api/matchup/${encodeURIComponent(matchupId)}`,
    fetcher,
    {
      revalidateOnFocus: false,
    },
  );

  if (isLoading) {
    const [leftRaw, rightRaw] = decodeURIComponent(matchupId).split("-vs-");
    const left = leftRaw ?? "Matchup";
    const right = rightRaw ?? "Guide";
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <Loader2 className="size-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">
          Generating matchup guide for {left} vs {right}...
        </p>
        <p className="text-xs text-muted-foreground">
          First visit takes 3-5 seconds. Future visits are instant.
        </p>
      </div>
    );
  }

  if (error || !guide) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Unable to load matchup guide</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Unknown matchup guide error."}
          </CardContent>
        </Card>
        <Button asChild>
          <Link href="/">Back to Search</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-2xl">
              {guide.champion} {guide.role} vs {guide.enemy} {guide.enemyRole}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge className={difficultyBadgeClass(guide.difficulty)}>
                {guide.difficulty.toUpperCase()}
              </Badge>
              <Badge variant="outline">Patch {guide.patch}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-center gap-4 rounded-xl border border-border/70 bg-background/30 p-4">
            <div className="flex items-center gap-2">
              <Image
                src={getChampionIconUrl(guide.champion)}
                alt={guide.champion}
                width={64}
                height={64}
                className="size-16 rounded-xl border border-border/70"
              />
              <div>
                <p className="text-lg font-semibold">{guide.champion}</p>
                <p className="text-xs text-muted-foreground">{guide.role}</p>
              </div>
            </div>
            <span className="text-sm font-semibold text-muted-foreground">VS</span>
            <div className="flex items-center gap-2">
              <Image
                src={getChampionIconUrl(guide.enemy)}
                alt={guide.enemy}
                width={64}
                height={64}
                className="size-16 rounded-xl border border-border/70"
              />
              <div>
                <p className="text-lg font-semibold">{guide.enemy}</p>
                <p className="text-xs text-muted-foreground">{guide.enemyRole}</p>
              </div>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{guide.summary}</p>
        </CardContent>
      </Card>

      <Card className="border-[#3b82f6]/40 bg-[#3b82f6]/10">
        <CardHeader>
          <CardTitle>Quick Tips</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {guide.tips.slice(0, 5).map((tip, index) => (
            <div key={tip} className="rounded-lg border border-border/70 bg-background/40 p-3">
              <p className="text-xs font-semibold text-primary">{index + 1}.</p>
              <p className="mt-1 text-sm text-foreground">{tip}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Trade Windows</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Best Window:</span>{" "}
              {guide.abilityTradeWindows.bestTradeWindow}
            </p>
            <p>
              <span className="font-medium text-foreground">All-in Read:</span>{" "}
              {guide.abilityTradeWindows.allInWinner}
            </p>
            <p>
              <span className="font-medium text-foreground">Danger Ability:</span>{" "}
              {guide.abilityTradeWindows.dangerAbility}
            </p>
            <div className="rounded-md border border-border/70 bg-background/30 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Key Cooldowns
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {guide.abilityTradeWindows.keyTimings.map((timing) => (
                  <li key={timing.ability}>
                    {timing.ability}: {Math.round(timing.cooldown)}s - {timing.window}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Power Spikes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {guide.powerSpikes.map((spike, index) => (
              <div
                key={`${spike.level}-${spike.minute}-${index}`}
                className="rounded-md border border-border/70 bg-background/30 p-3"
              >
                <p className="text-xs font-semibold text-foreground">
                  {spike.level > 0 ? `Level ${spike.level}` : "Item Spike"} (~{spike.minute}m)
                </p>
                <p className="text-sm text-muted-foreground">{spike.description}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Relative strength:{" "}
                  <span className="font-medium text-foreground">{spike.relativeStrength}</span>
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Early Game Guide</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Levels 1-3:</span>{" "}
              {guide.earlyGame.levels1to3}
            </p>
            <p>
              <span className="font-medium text-foreground">Trading Pattern:</span>{" "}
              {guide.earlyGame.tradingPattern}
            </p>
            <p>
              <span className="font-medium text-foreground">First Back Timing:</span>{" "}
              {guide.earlyGame.firstBackTiming}
            </p>
            <p>
              <span className="font-medium text-foreground">Jungle Considerations:</span>{" "}
              {guide.earlyGame.jungleConsiderations}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Level 6 And Midgame</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Level 6 Spike:</span>{" "}
              {guide.levelSixSpike}
            </p>
            <p>
              <span className="font-medium text-foreground">Mid Game:</span>{" "}
              {guide.midGame}
            </p>
            <p>
              <span className="font-medium text-foreground">Teamfighting:</span>{" "}
              {guide.teamfighting}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Build Path For This Matchup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <div className="flex flex-wrap gap-2">
            {guide.buildPath.recommended.map((item) => (
              <Badge key={item} variant="secondary">
                {item}
              </Badge>
            ))}
          </div>
          <p>{guide.buildPath.reasoning}</p>
        </CardContent>
      </Card>

      {guide.proReference ? (
        <Card>
          <CardHeader>
            <CardTitle>Pro Reference</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {guide.proReference}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Matchup Stats</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border/70 bg-background/30 p-3">
            <p className="text-xs text-muted-foreground">Patch Win Rate</p>
            <p className={`text-lg font-semibold ${winRateColor(guide.winRate)}`}>
              {(guide.winRate * 100).toFixed(1)}%
            </p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background/30 p-3">
            <p className="text-xs text-muted-foreground">Sample Size</p>
            <p className="text-lg font-semibold text-foreground">{guide.sampleSize}</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background/30 p-3">
            <p className="text-xs text-muted-foreground">First Blood Outlook</p>
            <p className="text-lg font-semibold text-foreground">
              {guide.difficulty === "easy"
                ? "Favorable"
                : guide.difficulty === "hard"
                  ? "Risky"
                  : "Even"}
            </p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background/30 p-3">
            <p className="text-xs text-muted-foreground">Lane Pressure @10</p>
            <p className="text-lg font-semibold text-foreground">
              {guide.difficulty === "easy"
                ? "Likely ahead"
                : guide.difficulty === "hard"
                  ? "Likely behind"
                  : "Skill matchup"}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/">Back to Search</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link
            href={`/pro/builds?champion=${encodeURIComponent(guide.champion)}&role=${encodeURIComponent(guide.role)}`}
          >
            Compare Pro Builds
          </Link>
        </Button>
      </div>
    </div>
  );
}
