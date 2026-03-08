"use client";

import Image from "next/image";
import Link from "next/link";
import { AlertTriangle, ArrowRightLeft, CheckCircle2 } from "lucide-react";
import { useMemo } from "react";
import useSWR from "swr";

import { CompTagBadge } from "@/components/CompTagBadge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getItemIconUrl } from "@/lib/data-dragon";
import type { BuildAnalysis, BuildRecommendation } from "@/lib/build-analyzer";
import type { CompTag } from "@/lib/comp-classifier";
import type { ContextualBuildRecommendation } from "@/lib/contextual-build-engine";
import type { MatchAnalysisOutput } from "@/lib/types/analysis";

type RecommendedItem = {
  itemId: number;
  itemName: string;
  reasoning: string;
};

export interface BuildComparisonProps {
  playerItems: number[];
  recommendation: BuildRecommendation;
  analysis: BuildAnalysis;
  allyCompTags: CompTag[];
  enemyCompTags: CompTag[];
  matchId?: string;
  playerPuuid?: string;
  proReference?: {
    text: string;
    href: string;
  } | null;
  contextualBuild?: ContextualBuildRecommendation;
  staleWarning?: {
    dataPatch: string;
    currentPatch: string;
  } | null;
}

function tagReason(tag: CompTag, isEnemy: boolean): string | null {
  if (isEnemy) {
    if (tag === "healing_heavy") {
      return "Enemy has Heavy Healing -> anti-heal should be prioritized.";
    }
    if (tag === "high_ap") {
      return "Enemy has High AP -> early MR is higher value.";
    }
    if (tag === "high_ad") {
      return "Enemy has High AD -> armor timing is critical.";
    }
    if (tag === "assassin_heavy") {
      return "Enemy has Assassin Threat -> add anti-burst tools.";
    }
    if (tag === "tank_heavy") {
      return "Enemy is Tank Heavy -> penetration/%HP damage recommended.";
    }
    if (tag === "cc_heavy") {
      return "Enemy CC chain potential -> tenacity and cleanse paths gain value.";
    }
    return null;
  }

  if (tag === "engage_comp") {
    return "Ally Engage Comp -> carries can build more damage follow-up.";
  }
  if (tag === "peel_heavy") {
    return "Ally Peel Heavy -> safer to play greedier DPS curves.";
  }
  if (tag === "split_push") {
    return "Split Push Identity -> side-lane and dueling items are stronger.";
  }

  return null;
}

export function BuildComparison({
  playerItems,
  recommendation,
  analysis,
  allyCompTags,
  enemyCompTags,
  matchId,
  playerPuuid,
  proReference,
  contextualBuild,
  staleWarning,
}: BuildComparisonProps) {
  const aiAnalysisKey =
    matchId && playerPuuid
      ? `/api/analysis/${encodeURIComponent(matchId)}?player=${encodeURIComponent(playerPuuid)}`
      : null;
  const { data: aiAnalysis, isLoading: aiLoading } = useSWR<MatchAnalysisOutput>(
    aiAnalysisKey,
    async (url: string) => {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Unable to load AI build notes.");
      }

      return (await response.json()) as MatchAnalysisOutput;
    },
    {
      revalidateOnFocus: true,
    },
  );
  const aiBuild = aiAnalysis?.build_analysis ?? null;

  const recommendedItems: RecommendedItem[] = useMemo(() => {
    const core = recommendation.coreItems.map((item) => ({
      itemId: item.itemId,
      itemName: item.itemName,
      reasoning: item.reasoning,
    }));
    const boots: RecommendedItem = {
      itemId: recommendation.boots.itemId,
      itemName: recommendation.boots.itemName,
      reasoning: recommendation.boots.reasoning,
    };
    const situational = recommendation.situationalItems.map((item) => ({
      itemId: item.itemId,
      itemName: item.itemName,
      reasoning: item.when,
    }));

    return [...core, boots, ...situational].slice(0, 7);
  }, [recommendation]);

  const builtItems = playerItems.filter((itemId) => itemId > 0);
  const recommendedSet = new Set(recommendedItems.map((item) => item.itemId));

  const matchedBuilt = builtItems.filter((itemId) => recommendedSet.has(itemId));
  const unmatchedBuilt = builtItems.filter((itemId) => !recommendedSet.has(itemId));
  const unmatchedRecommended = recommendedItems.filter((item) => !builtItems.includes(item.itemId));

  const swapSuggestions = unmatchedBuilt.slice(0, unmatchedRecommended.length).map((itemId, index) => ({
    builtItemId: itemId,
    recommended: unmatchedRecommended[index],
  }));

  const whyLines = [
    ...enemyCompTags.map((tag) => tagReason(tag, true)).filter((line): line is string => line !== null),
    ...allyCompTags.map((tag) => tagReason(tag, false)).filter((line): line is string => line !== null),
  ];

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Build Comparison</CardTitle>
            <Link
              href={proReference?.href ?? "/pro/builds"}
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              Pro Builds
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">{recommendation.overallStrategy}</p>
          {proReference ? (
            <p className="text-xs text-muted-foreground">{proReference.text}</p>
          ) : null}
          {staleWarning ? (
            <div className="rounded-md border border-[#f59e0b]/50 bg-[#f59e0b]/10 px-3 py-2 text-xs text-[#fde68a]">
              Build data is from patch {staleWarning.dataPatch}. New patch {staleWarning.currentPatch} may have changed optimal builds. Updated stats coming soon.
            </div>
          ) : null}
          {contextualBuild ? (
            <div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-muted-foreground">
              Contextual engine active: {contextualBuild.threats.length} threats detected,{" "}
              {contextualBuild.deviations.length} item swaps from generic OP.GG.
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-6">
          {contextualBuild ? (
            <div className="space-y-3 rounded-md border border-border/60 bg-background/30 p-3">
              <h4 className="text-sm font-semibold">Generic vs Contextual (This Exact Game)</h4>
              <div className="space-y-2 text-sm">
                {contextualBuild.build.items.map((item, index) => {
                  const genericItem = contextualBuild.genericBuild[index] ?? "N/A";
                  const builtItemId = builtItems[index];
                  const match = builtItemId && item.itemId && builtItemId === item.itemId;
                  return (
                    <div
                      key={`${item.slot}-${item.itemId ?? item.item}`}
                      className="rounded border border-border/50 px-2 py-2"
                    >
                      <p className="font-medium">
                        {item.slot}.{" "}
                        {match ? "[MATCH]" : "[SWAP]"}{" "}
                        {builtItemId ? `Item ${builtItemId}` : "Not built"}{" "}
                        {" -> "}
                        {item.item}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        OP.GG generic: {genericItem}
                      </p>
                      <p className="text-xs text-muted-foreground">{item.reason}</p>
                    </div>
                  );
                })}
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>Boots: {contextualBuild.build.boots.item}</p>
                <p>{contextualBuild.build.boots.reason}</p>
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground">Build Order Guidance</p>
                {contextualBuild.buildOrder.slice(0, 4).map((step) => (
                  <p key={`${step.phase}-${step.instruction}`}>
                    [{step.phase}] {step.instruction}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 rounded-md border border-border/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">What You Built</h3>
                <Badge variant="secondary">{matchedBuilt.length} matched</Badge>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {builtItems.slice(0, 8).map((itemId, index) => {
                  const matched = recommendedSet.has(itemId);
                  return (
                    <div key={`${itemId}-${index}`} className="space-y-1 text-center">
                      <div className="relative mx-auto w-fit">
                        <Image
                          src={getItemIconUrl(itemId)}
                          alt={`Built item ${itemId}`}
                          width={48}
                          height={48}
                          className="size-12 rounded-md border border-border/60"
                        />
                        {matched ? (
                          <CheckCircle2 className="absolute -bottom-1 -right-1 size-4 rounded-full bg-[#0a0e14] text-[#10b981]" />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-border/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Optimal for This Game</h3>
                <Badge variant="outline">Comp-aware</Badge>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {recommendedItems.map((item, index) => (
                  <Tooltip key={`${item.itemId}-${index}`}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="mx-auto rounded-md border border-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <Image
                          src={getItemIconUrl(item.itemId)}
                          alt={item.itemName}
                          width={48}
                          height={48}
                          className="size-12 rounded-md"
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>
                      <p>{item.itemName}</p>
                      <p className="text-[11px] opacity-90">{item.reasoning}</p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Swap Suggestions</h4>
            {swapSuggestions.length === 0 ? (
              <p className="text-sm text-[#10b981]">Your built items were mostly aligned with this matchup.</p>
            ) : (
              <div className="space-y-2">
                {swapSuggestions.map((swap) => (
                  <Tooltip key={`${swap.builtItemId}-${swap.recommended.itemId}`}>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-sm">
                        <Image
                          src={getItemIconUrl(swap.builtItemId)}
                          alt={`Built item ${swap.builtItemId}`}
                          width={28}
                          height={28}
                          className="size-7 rounded"
                        />
                        <ArrowRightLeft className="size-4 text-[#ef4444]" />
                        <Image
                          src={getItemIconUrl(swap.recommended.itemId)}
                          alt={swap.recommended.itemName}
                          width={28}
                          height={28}
                          className="size-7 rounded"
                        />
                        <span className="text-muted-foreground">{swap.recommended.itemName}</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{swap.recommended.reasoning}</p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>

          {analysis.missingItems.length > 0 ? (
            <div className="space-y-2 rounded-md border border-[#ef4444]/40 bg-[#ef4444]/10 p-3">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-[#fecaca]">
                <AlertTriangle className="size-4" /> Missing Critical Items
              </h4>
              <ul className="space-y-1 text-sm text-[#fecaca]">
                {analysis.missingItems.map((missing) => (
                  <li key={`${missing.itemName}-${missing.reasoning}`}>
                    {missing.itemName}: {missing.reasoning}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Why these items?</h4>
            <div className="flex flex-wrap gap-2">
              {allyCompTags.map((tag) => (
                <CompTagBadge key={`ally-${tag}`} tag={tag} />
              ))}
              {enemyCompTags.map((tag) => (
                <CompTagBadge key={`enemy-${tag}`} tag={tag} />
              ))}
            </div>
            <details className="rounded-md border border-border/60 bg-background/30 p-3">
              <summary className="cursor-pointer text-sm font-medium">Open item reasoning</summary>
              <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                {whyLines.length > 0 ? (
                  whyLines.map((line) => <p key={line}>- {line}</p>)
                ) : (
                  <p>- Comp matchup was neutral, so baseline core build remains stable.</p>
                )}
                {contextualBuild
                  ? contextualBuild.deviations.slice(0, 4).map((deviation) => (
                      <p key={`${deviation.genericItem}-${deviation.contextualItem}`}>
                        - Swapped {deviation.genericItem} for {deviation.contextualItem}:{" "}
                        {deviation.reason}
                      </p>
                    ))
                  : null}
              </div>
            </details>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-md border border-border/60 bg-background/30 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Build Rating
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">{analysis.rating.toUpperCase()}</p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {analysis.correctDecisions.slice(0, 3).map((line) => (
                  <li key={line}>- {line}</li>
                ))}
              </ul>
            </div>

            <div className="rounded-md border border-border/60 bg-background/30 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                AI Build Analysis
              </p>
              {aiLoading ? (
                <p className="mt-1 text-sm text-muted-foreground">Loading AI build notes...</p>
              ) : aiBuild ? (
                <div className="mt-1 space-y-2 text-sm text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">Rating:</span>{" "}
                    {aiBuild.rating}
                  </p>
                  <p>{aiBuild.explanation}</p>
                  {aiBuild.suggested_changes.length > 0 ? (
                    <ul className="space-y-1">
                      {aiBuild.suggested_changes.slice(0, 3).map((line) => (
                        <li key={line}>- {line}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">
                  AI build notes are available in the coaching analysis panel.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

