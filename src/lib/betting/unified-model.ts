import { type CompTag } from "@/lib/comp-classifier";

import { coachAnalyzer } from "./coach-fingerprint";
import { goldConversionModel } from "./gold-conversion";
import { liveGameModel, type LiveGameState } from "./live-game-model";
import { lineMovementTracker } from "./line-movement";
import { monteCarloDraftSimulator } from "./monte-carlo-draft";
import { orderFlowAnalyzer } from "./order-flow";
import { patchTransitionModel } from "./patch-alpha";
import { PredictionModel } from "./prediction-model";
import { regionalClashModel } from "./regional-clash";
import { rosterChangeDetector } from "./roster-detector";
import { seriesMomentumModel, type SeriesState } from "./series-momentum";
import { soloQueueSpy } from "./solo-queue-spy";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface FullMatchContext {
  matchId: string;
  fixtureId?: string;
  polymarketId?: string;
  team1: string;
  team2: string;
  league: string;
  team1Region?: string;
  team2Region?: string;
  event?: string;
  hostRegion?: string;
  side?: { team1: "blue" | "red" };
  marketProb?: number;
  patchAge?: number;
  isInternational?: boolean;
  draft?: {
    team1Champions: string[];
    team2Champions: string[];
    bans: string[];
  };
  disableFeatures?: string[];
}

export interface UnifiedPrediction {
  probability: number;
  confidence: "high" | "medium" | "low";
  shouldBet: boolean;
  marketProb: number;
  edge: number;
  uncertainty: number;
  uniqueEdgeSources: string[];
  kellyMultiplier: number;
  reasons: string[];
  components: {
    baseProb: number;
    monteCarloProb: number;
    monteCarloStdDev: number;
    edgeAdjustments: number;
  };
}

export class UnifiedBettingModel {
  private baseModel = new PredictionModel();

  async predict(matchContext: FullMatchContext): Promise<UnifiedPrediction> {
    const disabled = new Set((matchContext.disableFeatures ?? []).map((entry) => entry.toLowerCase()));
    const isOff = (key: string) => disabled.has(key.toLowerCase());

    const base = await this.baseModel.predict({
      team1: matchContext.team1,
      team2: matchContext.team2,
      league: matchContext.league,
      side: matchContext.side ?? { team1: "blue" },
      draft: matchContext.draft,
      includePlayerForm: true,
      includeEdgeSignals: true,
      fixtureId: matchContext.fixtureId,
    });

    const monteCarlo = isOff("monte_carlo")
      ? {
          team1ExpectedWinProb: base.team1WinProb,
          team2ExpectedWinProb: 1 - base.team1WinProb,
          standardDeviation: 0.08,
          draftVolatility: 0.5,
          bestCaseDraft: { team1Picks: [], team2Picks: [], bans: [], probability: 1, winProbability: base.team1WinProb },
          worstCaseDraft: { team1Picks: [], team2Picks: [], bans: [], probability: 1, winProbability: base.team1WinProb },
          distribution: [],
        }
      : await monteCarloDraftSimulator.simulate(
          matchContext.team1,
          matchContext.team2,
          2000,
        );

    const [soloSpy, rosterSignals, patchImpact, coachFactor, lineMovement, orderFlow, regional] =
      await Promise.all([
        isOff("solo_queue_spy")
          ? Promise.resolve(null)
          : soloQueueSpy.scanMatchPractice(matchContext.team1, matchContext.team2).catch(() => null),
        Promise.all([
          isOff("roster_detection")
            ? Promise.resolve({ risk: 0, topSignal: null })
            : rosterChangeDetector.getRosterRiskScore(matchContext.team1),
          isOff("roster_detection")
            ? Promise.resolve({ risk: 0, topSignal: null })
            : rosterChangeDetector.getRosterRiskScore(matchContext.team2),
        ]).catch(() => [{ risk: 0, topSignal: null }, { risk: 0, topSignal: null }] as const),
        isOff("patch_transition")
          ? Promise.resolve({
              team1Adjustment: 0,
              team2Adjustment: 0,
              reason: "Patch signal disabled",
              team1Impact: {
                overallImpact: 0,
                playerImpacts: [],
                teamAdaptability: 0.5,
                confidence: "low" as const,
              },
              team2Impact: {
                overallImpact: 0,
                playerImpacts: [],
                teamAdaptability: 0.5,
                confidence: "low" as const,
              },
            })
          : patchTransitionModel
          .getPatchTransitionEdge(
            matchContext.team1,
            matchContext.team2,
            [],
            matchContext.patchAge ?? 7,
          )
          .catch(() => ({
            team1Adjustment: 0,
            team2Adjustment: 0,
            reason: "Patch signal unavailable",
            team1Impact: {
              overallImpact: 0,
              playerImpacts: [],
              teamAdaptability: 0.5,
              confidence: "low" as const,
            },
            team2Impact: {
              overallImpact: 0,
              playerImpacts: [],
              teamAdaptability: 0.5,
              confidence: "low" as const,
            },
          })),
        isOff("coach_fingerprint")
          ? Promise.resolve({
              team1Adjustment: 0,
              team2Adjustment: 0,
              reason: "Coach fingerprint disabled",
            })
          : coachAnalyzer.getMatchupAdjustment(matchContext.team1, matchContext.team2).catch(() => ({
              team1Adjustment: 0,
              team2Adjustment: 0,
              reason: "Coach fingerprint unavailable",
            })),
        matchContext.fixtureId && !isOff("line_movement")
          ? lineMovementTracker
              .trackMovements(matchContext.fixtureId)
              .then((movements) => lineMovementTracker.getLineMovementAdjustment(movements))
              .catch(() => ({ team1Adjustment: 0, team2Adjustment: 0, reason: "No line movement" }))
          : Promise.resolve({ team1Adjustment: 0, team2Adjustment: 0, reason: "No fixture ID" }),
        matchContext.polymarketId && !isOff("order_flow")
          ? Promise.all([
              orderFlowAnalyzer.trackSmartWallets(matchContext.polymarketId),
              orderFlowAnalyzer.getOrderBookImbalance(matchContext.polymarketId),
              orderFlowAnalyzer.detectInformedTrading(matchContext.polymarketId),
            ]).catch(() => null)
          : Promise.resolve(null),
        (matchContext.isInternational || this.isInternational(matchContext.event ?? matchContext.league)) &&
        !isOff("regional_clash")
          ? regionalClashModel
              .getRegionalClashAdjustment(
                matchContext.team1,
                matchContext.team1Region ?? matchContext.league,
                matchContext.team2,
                matchContext.team2Region ?? matchContext.league,
                matchContext.event ?? matchContext.league,
                matchContext.patchAge ?? 7,
                matchContext.hostRegion,
              )
              .catch(() => ({ team1Adjustment: 0, team2Adjustment: 0, reasoning: "Regional signal unavailable" }))
          : Promise.resolve({ team1Adjustment: 0, team2Adjustment: 0, reasoning: "Domestic event" }),
      ]);

    let finalProb = base.team1WinProb * 0.4 + monteCarlo.team1ExpectedWinProb * 0.6;
    let edgeAdjustments = 0;
    const reasons: string[] = [];
    const uniqueEdgeSources: string[] = [];

    if (soloSpy) {
      const t1Strong = soloSpy.team1.filter((entry) => entry.confidenceScore >= 0.7).length;
      const t2Strong = soloSpy.team2.filter((entry) => entry.confidenceScore >= 0.7).length;
      const adj = clamp((t1Strong - t2Strong) * 0.008, -0.03, 0.03);
      finalProb += adj;
      edgeAdjustments += adj;
      if (Math.abs(adj) >= 0.01) {
        uniqueEdgeSources.push("solo_queue_spy");
        reasons.push(`Solo queue prep signal ${adj >= 0 ? "favors team1" : "favors team2"}.`);
      }
    }

    const rosterAdj = clamp((rosterSignals[1].risk - rosterSignals[0].risk) * 0.04, -0.05, 0.05);
    finalProb += rosterAdj;
    edgeAdjustments += rosterAdj;
    if (Math.abs(rosterAdj) >= 0.01) {
      uniqueEdgeSources.push("roster_detection");
      reasons.push("Roster instability signal active.");
    }

    finalProb += patchImpact.team1Adjustment;
    edgeAdjustments += patchImpact.team1Adjustment;
    if (Math.abs(patchImpact.team1Adjustment) >= 0.008) {
      uniqueEdgeSources.push("patch_transition");
      reasons.push("Patch transition adaptation edge active.");
    }

    finalProb += coachFactor.team1Adjustment;
    edgeAdjustments += coachFactor.team1Adjustment;
    if (Math.abs(coachFactor.team1Adjustment) >= 0.008) {
      uniqueEdgeSources.push("coach_fingerprint");
      reasons.push("Coach strategic fingerprint shift detected.");
    }

    finalProb += lineMovement.team1Adjustment;
    edgeAdjustments += lineMovement.team1Adjustment;
    if (Math.abs(lineMovement.team1Adjustment) >= 0.008) {
      uniqueEdgeSources.push("line_movement");
      reasons.push("Sharp line movement aligned with edge.");
    }

    finalProb += regional.team1Adjustment;
    edgeAdjustments += regional.team1Adjustment;
    if (Math.abs(regional.team1Adjustment) >= 0.008) {
      uniqueEdgeSources.push("regional_clash");
      reasons.push("Cross-regional style clash modifier applied.");
    }

    if (orderFlow) {
      const [walletFlow, imbalance, informed] = orderFlow;
      const flowSign =
        walletFlow.smartMoneyFlow === "team1"
          ? 1
          : walletFlow.smartMoneyFlow === "team2"
            ? -1
            : 0;
      const flowAdj = clamp(flowSign * walletFlow.confidence * 0.02, -0.03, 0.03);
      finalProb += flowAdj;
      edgeAdjustments += flowAdj;
      if (Math.abs(flowAdj) >= 0.008) {
        uniqueEdgeSources.push("order_flow");
        reasons.push("Polymarket order flow supports position.");
      }

      if (imbalance.predictedPriceDirection !== "neutral") {
        uniqueEdgeSources.push("order_book_imbalance");
      }
      if (informed.detected) {
        uniqueEdgeSources.push("smart_wallet");
        reasons.push(informed.evidence);
      }
    }

    finalProb = clamp(finalProb, 0.03, 0.97);
    const uncertainty = clamp(monteCarlo.standardDeviation, 0.01, 0.2);
    const marketProb = clamp(matchContext.marketProb ?? 0.5, 0.02, 0.98);
    const edge = finalProb - marketProb;

    const contradictsSharp =
      lineMovement.team1Adjustment * edge < -0.003;

    const shouldBet =
      Math.abs(edge) >= 0.08 &&
      uncertainty <= 0.05 &&
      uniqueEdgeSources.length >= 1 &&
      !contradictsSharp;

    const confidence = this.assessConfidence(
      uncertainty,
      uniqueEdgeSources.length,
      Math.abs(edge),
    );
    const kellyMultiplier = clamp(1 - uncertainty / 0.12, 0.25, 1);

    return {
      probability: finalProb,
      confidence,
      shouldBet,
      marketProb,
      edge,
      uncertainty,
      uniqueEdgeSources: [...new Set(uniqueEdgeSources)],
      kellyMultiplier,
      reasons,
      components: {
        baseProb: base.team1WinProb,
        monteCarloProb: monteCarlo.team1ExpectedWinProb,
        monteCarloStdDev: monteCarlo.standardDeviation,
        edgeAdjustments,
      },
    };
  }

  async predictNextGameInSeries(
    seriesState: SeriesState,
    matchContext: FullMatchContext,
  ): Promise<UnifiedPrediction> {
    const disabled = new Set((matchContext.disableFeatures ?? []).map((entry) => entry.toLowerCase()));

    const [pre, momentum, conversion] = await Promise.all([
      this.predict(matchContext),
      disabled.has("series_momentum")
        ? Promise.resolve({
            team1WinProbGame: 0.5,
            adjustments: [],
          })
        : seriesMomentumModel.predictNextGame(seriesState),
      disabled.has("gold_conversion")
        ? Promise.resolve({
            team1CloserRating: 0.5,
            team2CloserRating: 0.5,
            delta: 0,
          })
        : goldConversionModel.getTeamRatings(matchContext.team1, matchContext.team2),
    ]);

    let probability = pre.probability;
    let edgeAdjust = 0;

    edgeAdjust += momentum.team1WinProbGame - 0.5;
    edgeAdjust += conversion.delta * 0.25;
    probability = clamp(probability * 0.55 + momentum.team1WinProbGame * 0.45 + conversion.delta * 0.1, 0.03, 0.97);

    const marketProb = pre.marketProb;
    const edge = probability - marketProb;
    const uncertainty = clamp(pre.uncertainty * 0.75, 0.01, 0.18);
    const shouldBet =
      Math.abs(edge) >= 0.08 &&
      uncertainty <= 0.05 &&
      (pre.uniqueEdgeSources.length >= 1 || Math.abs(edgeAdjust) >= 0.03);

    return {
      ...pre,
      probability,
      shouldBet,
      edge,
      uncertainty,
      confidence: this.assessConfidence(uncertainty, pre.uniqueEdgeSources.length + 1, Math.abs(edge)),
      components: {
        ...pre.components,
        edgeAdjustments: pre.components.edgeAdjustments + edgeAdjust,
      },
      reasons: [
        ...pre.reasons,
        ...momentum.adjustments.map((entry) => `${entry.factor}: ${entry.explanation}`),
        `Gold conversion delta ${(conversion.delta * 100).toFixed(1)}%.`,
      ],
    };
  }

  async predictLive(
    liveState: LiveGameState,
    matchContext: FullMatchContext & {
      team1Comp: string[];
      team2Comp: string[];
      team1CompTags: CompTag[];
      team2CompTags: CompTag[];
    },
  ): Promise<UnifiedPrediction> {
    const disabled = new Set((matchContext.disableFeatures ?? []).map((entry) => entry.toLowerCase()));

    const [pre, live, conversion] = await Promise.all([
      this.predict(matchContext),
      disabled.has("live_game_model")
        ? Promise.resolve({
            team1WinProb: 0.5,
            factors: [],
          })
        : liveGameModel.predictLive(
            liveState,
            matchContext.team1Comp,
            matchContext.team2Comp,
            matchContext.team1CompTags,
            matchContext.team2CompTags,
          ),
      disabled.has("gold_conversion")
        ? Promise.resolve({
            teamSpecificWinProb: 0.5,
            genericWinProb: 0.5,
            delta: 0,
            sampleSize: 0,
          })
        : goldConversionModel.getConversionRate(
            matchContext.team1,
            liveState.goldDiff,
            liveState.timestamp / 60,
          ),
    ]);

    const probability = clamp(
      pre.probability * 0.25 +
        live.team1WinProb * 0.6 +
        conversion.teamSpecificWinProb * 0.15,
      0.02,
      0.98,
    );

    const marketProb = pre.marketProb;
    const edge = probability - marketProb;
    const uncertainty = clamp(pre.uncertainty * 0.6, 0.01, 0.15);
    const shouldBet =
      Math.abs(edge) >= 0.08 &&
      uncertainty <= 0.05 &&
      pre.uniqueEdgeSources.length >= 1;

    return {
      ...pre,
      probability,
      shouldBet,
      edge,
      uncertainty,
      confidence: this.assessConfidence(uncertainty, pre.uniqueEdgeSources.length + 1, Math.abs(edge)),
      reasons: [...pre.reasons, ...live.factors, `Team-specific conversion delta ${(conversion.delta * 100).toFixed(1)}%.`],
    };
  }

  private assessConfidence(
    uncertainty: number,
    edgeSources: number,
    edge: number,
  ): "high" | "medium" | "low" {
    if (uncertainty <= 0.035 && edgeSources >= 2 && edge >= 0.1) {
      return "high";
    }
    if (uncertainty <= 0.055 && edgeSources >= 1 && edge >= 0.06) {
      return "medium";
    }
    return "low";
  }

  private isInternational(value: string): boolean {
    const normalized = value.toLowerCase();
    return (
      normalized.includes("world") ||
      normalized.includes("msi") ||
      normalized.includes("international")
    );
  }
}

export const unifiedBettingModel = new UnifiedBettingModel();
