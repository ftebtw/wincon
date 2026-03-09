"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";

import { CompTagBadge } from "@/components/CompTagBadge";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorCard } from "@/components/ErrorCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getChampionIconUrl, getItemIconUrl } from "@/lib/data-dragon";
import type { ContextualBuildRecommendation } from "@/lib/contextual-build-engine";
import type { LiveGameScoutOutput } from "@/lib/types/analysis";
import type { DualCompAnalysis } from "@/lib/comp-classifier";

type ScoutParticipant = {
  puuid: string;
  championId: number;
  championName: string;
  role: "TOP" | "JUNGLE" | "MID" | "ADC" | "SUPPORT";
  spellIds: number[];
  spellNames: string[];
  teamId: number;
};

type EnemyScoutingStats = {
  puuid: string;
  championId: number;
  championName: string;
  role: "TOP" | "JUNGLE" | "MID" | "ADC" | "SUPPORT";
  rank: string;
  recentRecord: string;
  avgKDA: string;
  firstItem: string;
  preferredSpells: string[];
  aggression: number;
  playstyle: string;
  keyThreat: string;
  sampleSize: number;
  csAt10?: number;
  name?: string;
};

type LiveGameApiResponse =
  | {
      inGame: false;
      checkedAt: string;
    }
  | {
      inGame: true;
      loadingMoreData: boolean;
      checkedAt: string;
      game: {
        gameId: number;
        gameMode: string;
        gameType: string;
        gameStartTime: number;
        gameLength: number;
      };
      player: {
        puuid: string;
        championId: number;
        championName: string;
        role: "TOP" | "JUNGLE" | "MID" | "ADC" | "SUPPORT";
        rank: string;
        teamId: number;
      };
      teams: {
        ally: ScoutParticipant[];
        enemy: ScoutParticipant[];
      };
      compAnalysis: DualCompAnalysis;
      laneOpponent: EnemyScoutingStats;
      allEnemies: EnemyScoutingStats[];
      aiScout: LiveGameScoutOutput;
      winProbability: {
        ally: number;
        enemy: number;
        confidence: "low" | "medium" | "high";
        summary: string;
        factors: Array<{
          label: string;
          impact: number;
          detail: string;
        }>;
      };
      abilityIcons?: {
        our: Record<"P" | "Q" | "W" | "E" | "R", string | null>;
        enemy: Record<"P" | "Q" | "W" | "E" | "R", string | null>;
      };
      keyAbilityIcon?: string | null;
      laneMatchupIcons?: {
        ourChampionIcon?: string | null;
        enemyChampionIcon?: string | null;
      };
      matchupGuide?: {
        id: string;
        summary: string;
        tips: string[];
        difficulty: "easy" | "medium" | "hard";
        winRate: number;
      } | null;
      abilityMatchupContext?: string | null;
      recommendedBuild: {
        items: Array<{ itemName: string; itemId?: number }>;
        reasoning: string;
      };
      contextualBuild?: ContextualBuildRecommendation;
      teamFightPlan: LiveGameScoutOutput["team_fight_plan"];
      proMatchupTip?: string | null;
    };

type LiveGameFetchError = {
  status?: number;
  message: string;
  retryAfter?: number;
};

function formatRole(role: ScoutParticipant["role"]): string {
  if (role === "JUNGLE") {
    return "JG";
  }
  if (role === "SUPPORT") {
    return "SUP";
  }
  return role;
}

function formatGameDuration(startTimeMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function difficultyBadgeClass(difficulty: LiveGameScoutOutput["lane_matchup"]["difficulty"]): string {
  if (difficulty === "easy") {
    return "bg-[#10b981] text-black";
  }
  if (difficulty === "hard") {
    return "bg-[#ef4444] text-white";
  }
  return "bg-[#f59e0b] text-black";
}

function probabilityBarClass(value: number): string {
  if (value >= 0.55) {
    return "bg-[#10b981]";
  }
  if (value <= 0.45) {
    return "bg-[#ef4444]";
  }
  return "bg-[#f59e0b]";
}

async function liveGameFetcher(url: string): Promise<LiveGameApiResponse> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      retryAfter?: number;
    };

    throw {
      status: response.status,
      message: payload.error ?? "Failed to load live game scout.",
      retryAfter: payload.retryAfter,
    } satisfies LiveGameFetchError;
  }

  return (await response.json()) as LiveGameApiResponse;
}

function ScoutProgress({ steps }: { steps: string[] }) {
  const [scoutStep, setScoutStep] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setScoutStep((previous) => Math.min(previous + 1, 2));
    }, 1200);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scouting enemies...</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {steps.map((step, index) => (
          <div key={step} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <p className="text-muted-foreground">{step}</p>
              <p className={index <= scoutStep ? "text-[#10b981]" : "text-muted-foreground"}>
                {index < scoutStep ? "Done" : index === scoutStep ? "In progress" : "Pending"}
              </p>
            </div>
            <div className="h-2 rounded-full bg-border/60">
              <div
                className="h-2 rounded-full bg-primary transition-all"
                style={{ width: index < scoutStep ? "100%" : index === scoutStep ? "65%" : "15%" }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function LiveGamePage() {
  const params = useParams<{ riotId: string }>();
  const riotId = params?.riotId ?? "";
  const [countdown, setCountdown] = useState(15);

  const { data, error, isLoading, isValidating, mutate } = useSWR<LiveGameApiResponse, LiveGameFetchError>(
    riotId ? `/api/livegame/${encodeURIComponent(riotId)}` : null,
    liveGameFetcher,
    {
      refreshInterval: 15_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
    },
  );

  useEffect(() => {
    if (!data || data.inGame || !riotId) {
      return;
    }

    const interval = setInterval(() => {
      setCountdown((previous) => {
        if (previous <= 1) {
          mutate();
          return 15;
        }

        return previous - 1;
      });
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, [data, riotId, mutate]);

  const decodedRiotId = useMemo(() => decodeURIComponent(riotId), [riotId]);
  const steps = ["Fetching live game", "Analyzing compositions", "Generating advice"];

  if (isLoading && !data) {
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-8">
        <ScoutProgress steps={steps} />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        <ErrorCard
          statusCode={error.status}
          title={error.status === 503 ? "Riot's servers are having issues." : "Live Scout Unavailable"}
          description={error.message}
          retryAfterSeconds={error.retryAfter}
          onRetry={() => mutate()}
        />
      </div>
    );
  }

  if (!data || !data.inGame) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Not currently in a game</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {decodedRiotId || "Player"} is currently offline or in queue.
            </p>
            <div className="flex items-center gap-3">
              <Button onClick={() => mutate()}>Check again</Button>
              <p className="text-xs text-muted-foreground">
                Auto-checking in {countdown}s
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const scout = data;

  return (
    <ErrorBoundary
      title="Live Scout Unavailable"
      description="Something went wrong while rendering the scouting report. Please try again."
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
        {isValidating ? (
          <Card className="border-primary/40 bg-primary/10">
            <CardContent className="py-3 text-sm text-primary">Refreshing scouting data...</CardContent>
          </Card>
        ) : null}

      <Card className="border-[#3b82f6]/40 bg-[#3b82f6]/10">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-2xl">3 Things to Remember</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{decodedRiotId}</Badge>
              <Badge variant="outline">{formatGameDuration(scout.game.gameStartTime)}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          {scout.aiScout.three_things_to_remember.slice(0, 3).map((line, index) => (
            <div
              key={`${line}-${index}`}
              className="rounded-xl border border-border/70 bg-background/40 p-4"
            >
              <p className="text-sm font-semibold text-primary">{index + 1}.</p>
              <p className="mt-1 text-base font-medium text-foreground">{line}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Pre-Game Win Probability</CardTitle>
            <Badge variant="outline">
              Confidence: {scout.winProbability.confidence.toUpperCase()}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border/70 bg-background/30 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Your Team</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">
                {(scout.winProbability.ally * 100).toFixed(1)}%
              </p>
            </div>
            <div className="rounded-lg border border-border/70 bg-background/30 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Enemy Team</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">
                {(scout.winProbability.enemy * 100).toFixed(1)}%
              </p>
            </div>
          </div>
          <div className="h-3 rounded-full bg-border/60">
            <div
              className={`h-3 rounded-full transition-all ${probabilityBarClass(scout.winProbability.ally)}`}
              style={{ width: `${Math.round(scout.winProbability.ally * 100)}%` }}
            />
          </div>
          <p className="text-sm text-muted-foreground">{scout.winProbability.summary}</p>
          <div className="space-y-2">
            {scout.winProbability.factors.slice(0, 5).map((factor) => (
              <div
                key={`${factor.label}-${factor.impact}`}
                className="rounded-md border border-border/60 bg-background/20 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-foreground">{factor.label}</p>
                  <Badge
                    variant="outline"
                    className={factor.impact >= 0 ? "text-[#34d399]" : "text-[#f87171]"}
                  >
                    {(factor.impact * 100).toFixed(1)}%
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{factor.detail}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {scout.loadingMoreData ? (
        <Card className="border-[#f59e0b]/50 bg-[#f59e0b]/10">
          <CardContent className="py-3 text-sm text-[#fcd34d]">
            Loading more data... showing partial enemy history to stay within rate limits.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Team Compositions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border/70 bg-[#10b981]/10 p-3">
            <p className="mb-2 text-sm font-semibold">Your Team</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {scout.teams.ally.map((participant) => (
                <div
                  key={participant.puuid}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-2"
                >
                  <Image
                    src={getChampionIconUrl(participant.championName)}
                    alt={participant.championName}
                    width={36}
                    height={36}
                    className="size-9 rounded-md"
                  />
                  <div>
                    <p className="text-xs font-semibold text-foreground">{participant.championName}</p>
                    <p className="text-[11px] text-muted-foreground">{formatRole(participant.role)}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {scout.compAnalysis.ally.tags.map((tag) => (
                <CompTagBadge key={`ally-${tag}`} tag={tag} />
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border/70 bg-[#ef4444]/10 p-3">
            <p className="mb-2 text-sm font-semibold">Enemy Team</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {scout.teams.enemy.map((participant) => (
                <div
                  key={participant.puuid}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-2"
                >
                  <Image
                    src={getChampionIconUrl(participant.championName)}
                    alt={participant.championName}
                    width={36}
                    height={36}
                    className="size-9 rounded-md"
                  />
                  <div>
                    <p className="text-xs font-semibold text-foreground">{participant.championName}</p>
                    <p className="text-[11px] text-muted-foreground">{formatRole(participant.role)}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {scout.compAnalysis.enemy.tags.map((tag) => (
                <CompTagBadge key={`enemy-${tag}`} tag={tag} />
              ))}
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            Their comp wants: {scout.aiScout.team_fight_plan.their_comp_identity}. Your comp wants: {" "}
            {scout.aiScout.team_fight_plan.our_comp_identity}.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lane Matchup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2">
              <Image
                src={scout.laneMatchupIcons?.ourChampionIcon ?? getChampionIconUrl(scout.player.championName)}
                alt={scout.player.championName}
                width={40}
                height={40}
                className="size-10 rounded-md"
              />
              <div>
                <p className="text-xs text-muted-foreground">You</p>
                <p className="text-sm font-semibold">{scout.player.championName}</p>
              </div>
            </div>
            <span className="text-sm text-muted-foreground">vs</span>
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2">
              <Image
                src={scout.laneMatchupIcons?.enemyChampionIcon ?? getChampionIconUrl(scout.laneOpponent.championName)}
                alt={scout.laneOpponent.championName}
                width={40}
                height={40}
                className="size-10 rounded-md"
              />
              <div>
                <p className="text-xs text-muted-foreground">Enemy</p>
                <p className="text-sm font-semibold">{scout.laneOpponent.championName}</p>
              </div>
            </div>
            <Badge className={difficultyBadgeClass(scout.aiScout.lane_matchup.difficulty)}>
              {scout.aiScout.lane_matchup.difficulty.toUpperCase()}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Their Win Condition:</span>{" "}
            {scout.aiScout.lane_matchup.their_win_condition}
          </p>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Your Win Condition:</span>{" "}
            {scout.aiScout.lane_matchup.your_win_condition}
          </p>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Power Spikes:</span>{" "}
            {scout.aiScout.lane_matchup.power_spikes}
          </p>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Key Ability:</span>{" "}
            {scout.keyAbilityIcon ? (
              <Image
                src={scout.keyAbilityIcon}
                alt="Key ability icon"
                width={18}
                height={18}
                className="mr-1 inline-block size-5 rounded-sm align-text-bottom"
              />
            ) : null}
            {scout.aiScout.lane_matchup.key_ability_to_watch}
          </p>
          {scout.abilityIcons ? (
            <div className="rounded-md border border-border/70 bg-background/30 p-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Enemy Ability Icons
              </p>
              <div className="mt-2 flex items-center gap-2">
                {(["Q", "W", "E", "R"] as const).map((slot) => (
                  <div key={slot} className="flex items-center gap-1 rounded border border-border/60 px-2 py-1">
                    {scout.abilityIcons?.enemy[slot] ? (
                      <Image
                        src={scout.abilityIcons.enemy[slot] ?? ""}
                        alt={`${slot} ability`}
                        width={18}
                        height={18}
                        className="size-5 rounded-sm"
                      />
                    ) : (
                      <span className="inline-block size-5 rounded-sm border border-dashed border-border/60" />
                    )}
                    <span className="text-[11px] text-muted-foreground">{slot}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {scout.proMatchupTip ? (
            <div className="rounded-md border border-primary/40 bg-primary/10 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-primary">Pro Tip</p>
              <p className="mt-1 text-sm text-muted-foreground">{scout.proMatchupTip}</p>
            </div>
          ) : null}
          {scout.matchupGuide ? (
            <div className="rounded-md border border-[#3b82f6]/40 bg-[#3b82f6]/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#93c5fd]">
                  Matchup Guide
                </p>
                <Badge variant="outline">
                  {Math.round(scout.matchupGuide.winRate * 100)}% WR
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{scout.matchupGuide.summary}</p>
              {scout.matchupGuide.tips.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {scout.matchupGuide.tips.slice(0, 2).map((tip) => (
                    <li key={tip}>- {tip}</li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-3">
                <Button asChild size="sm" variant="secondary">
                  <Link href={`/matchup/${encodeURIComponent(scout.matchupGuide.id)}`}>
                    Open Full Matchup Guide
                  </Link>
                </Button>
              </div>
            </div>
          ) : null}
          {scout.abilityMatchupContext ? (
            <p className="text-xs text-muted-foreground">{scout.abilityMatchupContext}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Enemy Laner Deep Dive</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Champion:</span>{" "}
              {scout.laneOpponent.championName} ({formatRole(scout.laneOpponent.role)})
            </p>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Rank:</span> {scout.laneOpponent.rank}
            </p>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Recent Record:</span>{" "}
              {scout.laneOpponent.recentRecord} ({scout.laneOpponent.avgKDA} KDA)
            </p>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Typical First Item:</span>{" "}
              {scout.laneOpponent.firstItem}
            </p>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Preferred Spells:</span>{" "}
              {scout.laneOpponent.preferredSpells.join(" + ")}
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Playstyle:</span>{" "}
              {scout.aiScout.enemy_player_tendencies.playstyle}
            </p>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Aggression Score:</span>{" "}
              {scout.laneOpponent.aggression.toFixed(2)}
            </p>
            <div className="rounded-md border border-border/70 bg-background/30 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Exploitable Weaknesses
              </p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {scout.aiScout.enemy_player_tendencies.exploitable_weaknesses.map((weakness) => (
                  <li key={weakness}>- {weakness}</li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">
              Danger zones: {scout.aiScout.enemy_player_tendencies.danger_zones.join(", ") || "N/A"}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Enemies Overview</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {scout.allEnemies.map((enemy) => (
            <div
              key={enemy.puuid}
              className="rounded-md border border-border/70 bg-background/40 p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <Image
                  src={getChampionIconUrl(enemy.championName)}
                  alt={enemy.championName}
                  width={30}
                  height={30}
                  className="size-8 rounded"
                />
                <div>
                  <p className="text-xs font-semibold text-foreground">{enemy.championName}</p>
                  <p className="text-[11px] text-muted-foreground">{formatRole(enemy.role)}</p>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">{enemy.rank}</p>
              <p className="text-[11px] text-muted-foreground">{enemy.recentRecord}</p>
              <p className="mt-1 text-[11px] text-foreground">Threat: {enemy.keyThreat}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recommended Build Path</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {scout.recommendedBuild.items.map((item) => (
              <div
                key={`${item.itemName}-${item.itemId ?? "unknown"}`}
                className="flex items-center gap-2 rounded-md border border-border/70 bg-background/40 px-2 py-2"
              >
                {item.itemId ? (
                  <Image
                    src={getItemIconUrl(item.itemId)}
                    alt={item.itemName}
                    width={28}
                    height={28}
                    className="size-7 rounded"
                  />
                ) : (
                  <div className="size-7 rounded border border-dashed border-border/70" />
                )}
                <p className="text-xs text-foreground">{item.itemName}</p>
              </div>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{scout.recommendedBuild.reasoning}</p>
          {scout.contextualBuild ? (
            <div className="space-y-3 rounded-md border border-border/70 bg-background/30 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Threats Detected
              </p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {scout.contextualBuild.threats.slice(0, 4).map((threat) => (
                  <li key={threat.threatType}>
                    {threat.severity.toUpperCase()}: {threat.threatType.replace(/_/g, " ")}{" "}
                    {threat.sourceChampions.length > 0
                      ? `(${threat.sourceChampions.join(", ")})`
                      : ""}
                  </li>
                ))}
              </ul>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                OP.GG Generic vs Contextual
              </p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {scout.contextualBuild.deviations.slice(0, 3).map((deviation) => (
                  <li key={`${deviation.genericItem}-${deviation.contextualItem}`}>
                    {deviation.genericItem}
                    {" -> "}
                    {deviation.contextualItem}: {deviation.reason}
                  </li>
                ))}
                {scout.contextualBuild.deviations.length === 0 ? (
                  <li>No item swaps required in this matchup.</li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Team Fight Plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Their Identity:</span>{" "}
            {scout.teamFightPlan.their_comp_identity}
          </p>
          <p>
            <span className="font-medium text-foreground">Our Identity:</span>{" "}
            {scout.teamFightPlan.our_comp_identity}
          </p>
          <p>
            <span className="font-medium text-foreground">How to Win Fights:</span>{" "}
            {scout.teamFightPlan.how_to_win_fights}
          </p>
        </CardContent>
      </Card>

      {error ? (
        <ErrorCard
          statusCode={error.status}
          description={error.message}
          retryAfterSeconds={error.retryAfter}
          onRetry={() => mutate()}
        />
      ) : null}
    </div>
    </ErrorBoundary>
  );
}
