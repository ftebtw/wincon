import { gte, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

import { oddsClient, type BestOddsResult, type OddsFixture } from "./odds-api";
import { type PolymarketMarket, PolymarketClient } from "./polymarket";
import { type UnifiedPrediction, unifiedBettingModel } from "./unified-model";

export interface AutoBettorConfig {
  enabled: boolean;
  bankroll: number;
  minEdge: number;
  maxBetFraction: number;
  maxDailyBets: number;
  maxDailyLoss: number;
  betSizing: "kelly" | "flat";
  flatBetSize?: number;
  dryRun: boolean;
  leagues: string[];
}

export interface BettingOpportunity {
  fixture: OddsFixture;
  ourPrediction: UnifiedPrediction;
  pinnacleProb: { home: number; away: number };
  bestOdds: BestOddsResult;
  edge: number;
  recommendedBookmaker: string;
  recommendedOdds: number;
  recommendedSide: "home" | "away";
  deepLink: string | null;
  kellySuggestedBet: number;
  polymarketAvailable: boolean;
  polymarketMarketId?: string;
  reasoning: string;
  predictionId?: number;
}

export interface BettingScanResult {
  opportunities: BettingOpportunity[];
  betsPlaced: number;
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function inferLeague(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized.includes("lck")) return "LCK";
  if (normalized.includes("lec")) return "LEC";
  if (normalized.includes("lpl")) return "LPL";
  if (normalized.includes("lcs")) return "LCS";
  return label.toUpperCase();
}

export class AutoBettor {
  private config: AutoBettorConfig;
  private polymarket: PolymarketClient;

  constructor(config: AutoBettorConfig) {
    this.config = config;
    this.polymarket = new PolymarketClient();
  }

  async scan(): Promise<BettingScanResult> {
    if (!this.config.enabled) {
      return {
        opportunities: [],
        betsPlaced: 0,
        reason: "Auto-betting disabled",
      };
    }

    const [fixtures, polymarketMarkets] = await Promise.all([
      oddsClient.getUpcomingFixtures(),
      this.polymarket.findLoLMarkets().catch(() => []),
    ]);

    const opportunities: BettingOpportunity[] = [];

    for (const fixtureOdds of fixtures) {
      const league = inferLeague(fixtureOdds.fixture.league);
      if (!this.config.leagues.includes(league)) {
        continue;
      }

      const bestOdds = oddsClient.summarizeBestOdds(fixtureOdds);
      const pinnacleProb = bestOdds.pinnacle
        ? oddsClient.removeVig(bestOdds.pinnacle.homeOdds, bestOdds.pinnacle.awayOdds)
        : fixtureOdds.consensusProb;

      const prediction = await unifiedBettingModel.predict({
        matchId: fixtureOdds.fixture.id,
        fixtureId: fixtureOdds.fixture.id,
        team1: fixtureOdds.fixture.homeTeam,
        team2: fixtureOdds.fixture.awayTeam,
        league,
        side: { team1: "blue" },
        marketProb: pinnacleProb.home,
        event: fixtureOdds.fixture.league,
      });

      const predictionInsert = await db
        .insert(schema.bettingPredictions)
        .values({
          matchIdentifier: `${fixtureOdds.fixture.homeTeam}-vs-${fixtureOdds.fixture.awayTeam}-${new Date(
            fixtureOdds.fixture.startTime,
          )
            .toISOString()
            .slice(0, 10)}`,
          team1: fixtureOdds.fixture.homeTeam,
          team2: fixtureOdds.fixture.awayTeam,
          league,
          team1WinProb: prediction.probability.toFixed(4),
          confidence: prediction.confidence,
          factors: prediction.reasons.map((reason) => ({ category: "unified", factor: reason })),
          draftFeatures: {
            uncertainty: prediction.uncertainty,
            uniqueEdgeSources: prediction.uniqueEdgeSources,
            components: prediction.components,
          },
        })
        .returning({ id: schema.bettingPredictions.id });

      const edgeVsPinnacle = prediction.probability - pinnacleProb.home;

      if (Math.abs(edgeVsPinnacle) < this.config.minEdge || !prediction.shouldBet) {
        continue;
      }

      const recommendedSide: "home" | "away" = edgeVsPinnacle >= 0 ? "home" : "away";
      const bestLeg = recommendedSide === "home" ? bestOdds.bestHome : bestOdds.bestAway;
      const recommendedOdds =
        recommendedSide === "home" ? bestLeg.homeOdds : bestLeg.awayOdds;
      const marketProb = 1 / Math.max(recommendedOdds, 1.0001);
      const modelProb =
        recommendedSide === "home" ? prediction.probability : 1 - prediction.probability;
      const edgeVsBest = modelProb - marketProb;

      const poly = this.findPolymarketForFixture(fixtureOdds.fixture, polymarketMarkets);

      opportunities.push({
        fixture: fixtureOdds.fixture,
        ourPrediction: prediction,
        pinnacleProb,
        bestOdds,
        edge: edgeVsBest,
        recommendedBookmaker: bestLeg.bookmaker,
        recommendedOdds,
        recommendedSide,
        deepLink: bestLeg.deepLink ?? null,
        polymarketAvailable: Boolean(poly),
        polymarketMarketId: poly?.conditionId,
        kellySuggestedBet: this.calculateBetSize(
          modelProb,
          marketProb,
          Math.abs(edgeVsBest),
          prediction.uncertainty,
          prediction.kellyMultiplier,
        ),
        reasoning:
          `Unified model ${(modelProb * 100).toFixed(1)}% vs market ${(marketProb * 100).toFixed(1)}%` +
          ` (${(edgeVsBest * 100).toFixed(1)}% edge). Uncertainty ${(prediction.uncertainty * 100).toFixed(1)}%.` +
          ` Edge sources: ${prediction.uniqueEdgeSources.join(", ") || "none"}.`,
        predictionId: predictionInsert[0]?.id,
      });
    }

    const todaysBets = await this.getTodaysBets();
    if (todaysBets.count >= this.config.maxDailyBets) {
      return { opportunities, betsPlaced: 0, reason: "Daily bet limit reached" };
    }

    if (todaysBets.totalLoss >= this.config.maxDailyLoss) {
      return { opportunities, betsPlaced: 0, reason: "Daily loss limit reached" };
    }

    // High selectivity: take only top 10-15% of opportunities by edge.
    const sorted = [...opportunities].sort((a, b) => b.edge - a.edge);
    const cutoff = Math.max(1, Math.floor(sorted.length * 0.15));
    const selected = sorted.slice(0, cutoff);

    let betsPlaced = 0;

    for (const opportunity of selected) {
      if (betsPlaced >= this.config.maxDailyBets - todaysBets.count) {
        break;
      }

      if (opportunity.kellySuggestedBet <= 0) {
        continue;
      }

      if (this.config.dryRun) {
        await this.logBet(opportunity, "dry_run", undefined, "oddspapi_manual");
        betsPlaced += 1;
        continue;
      }

      if (!opportunity.polymarketMarketId) {
        await this.logBet(opportunity, "manual_recommended", undefined, "oddspapi_manual");
        continue;
      }

      const poly = this.findPolymarketForFixture(opportunity.fixture, polymarketMarkets);
      if (!poly) {
        await this.logBet(opportunity, "manual_recommended", undefined, "oddspapi_manual");
        continue;
      }

      const polySide = this.mapPolymarketSide(
        opportunity.fixture,
        opportunity.recommendedSide,
        poly,
      );
      if (!polySide) {
        await this.logBet(opportunity, "manual_recommended", undefined, "oddspapi_manual");
        continue;
      }

      const yesProb = opportunity.ourPrediction.probability;
      const result = await this.polymarket.placeBet({
        conditionId: opportunity.polymarketMarketId,
        side: polySide,
        amount: opportunity.kellySuggestedBet,
        price: clamp((polySide === "Yes" ? yesProb : 1 - yesProb) - 0.01, 0.05, 0.95),
      });

      await this.logBet(opportunity, "placed", result.orderId, "polymarket");
      betsPlaced += 1;
    }

    return {
      opportunities: selected,
      betsPlaced,
      reason: "ok",
    };
  }

  private calculateBetSize(
    ourProb: number,
    marketProb: number,
    edge: number,
    uncertainty: number,
    kellyMultiplier: number,
  ): number {
    if (this.config.betSizing === "flat") {
      return this.config.flatBetSize ?? Math.min(10, this.config.bankroll * this.config.maxBetFraction);
    }

    const b = (1 / marketProb) - 1;
    const p = ourProb;
    const q = 1 - p;

    if (b <= 0) {
      return 0;
    }

    let fraction = (b * p - q) / b;
    fraction *= 0.5; // half Kelly safety
    fraction = clamp(fraction, 0, this.config.maxBetFraction);
    fraction *= clamp(edge / Math.max(this.config.minEdge, 0.0001), 0.6, 1.2);
    fraction *= clamp(kellyMultiplier, 0.25, 1);
    fraction *= clamp(1 - uncertainty / 0.12, 0.25, 1);

    return this.config.bankroll * fraction;
  }

  private async getTodaysBets(): Promise<{ count: number; totalLoss: number }> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const rows = await db
      .select({
        count: sql<number>`count(*)`,
        totalLoss: sql<number>`coalesce(sum(case when ${schema.bettingLog.pnl} < 0 then abs(${schema.bettingLog.pnl}) else 0 end), 0)`,
      })
      .from(schema.bettingLog)
      .where(gte(schema.bettingLog.createdAt, start));

    return {
      count: toNumber(rows[0]?.count, 0),
      totalLoss: toNumber(rows[0]?.totalLoss, 0),
    };
  }

  private findPolymarketForFixture(
    fixture: OddsFixture,
    markets: PolymarketMarket[],
  ): PolymarketMarket | null {
    const home = normalizeText(fixture.homeTeam);
    const away = normalizeText(fixture.awayTeam);

    for (const market of markets) {
      const normalizedQuestion = normalizeText(market.question);
      if (normalizedQuestion.includes(home) && normalizedQuestion.includes(away)) {
        return market;
      }
    }

    return null;
  }

  private mapPolymarketSide(
    fixture: OddsFixture,
    recommendedSide: "home" | "away",
    market: PolymarketMarket,
  ): "Yes" | "No" | null {
    const parsed = this.parseMarketTeams(market.question);
    if (!parsed) {
      return null;
    }

    const marketTeam1 = normalizeText(parsed.team1);
    const fixtureHome = normalizeText(fixture.homeTeam);

    if (recommendedSide === "home") {
      return marketTeam1 === fixtureHome ? "Yes" : "No";
    }

    return marketTeam1 === fixtureHome ? "No" : "Yes";
  }

  private parseMarketTeams(question: string): { team1: string; team2: string; league: string } | null {
    const cleaned = question.replace(/\s+/g, " ").trim();

    const versusMatch = cleaned.match(/([A-Za-z0-9.'-]+)\s+(?:vs\.?|versus)\s+([A-Za-z0-9.'-]+)/i);
    const willWinMatch = cleaned.match(/will\s+([A-Za-z0-9.'-]+)\s+beat\s+([A-Za-z0-9.'-]+)/i);

    const match = versusMatch ?? willWinMatch;
    if (!match) {
      return null;
    }

    return {
      team1: match[1],
      team2: match[2],
      league: inferLeague(cleaned),
    };
  }

  private async logBet(
    opp: BettingOpportunity,
    status: string,
    orderId?: string,
    platform = "polymarket",
  ): Promise<void> {
    const bankrollBefore = this.config.bankroll;

    await db.insert(schema.bettingLog).values({
      predictionId: opp.predictionId ?? null,
      platform,
      marketId: opp.polymarketMarketId ?? opp.fixture.id,
      side: opp.recommendedSide,
      ourProbability: (opp.recommendedSide === "home"
        ? opp.ourPrediction.probability
        : 1 - opp.ourPrediction.probability).toFixed(4),
      marketProbability: (1 / Math.max(opp.recommendedOdds, 1.0001)).toFixed(4),
      edge: opp.edge.toFixed(4),
      betAmount: opp.kellySuggestedBet.toFixed(2),
      status,
      orderId: orderId ?? null,
      pnl: null,
      bankrollBefore: bankrollBefore.toFixed(2),
      bankrollAfter: bankrollBefore.toFixed(2),
    });
  }
}

export function getAutoBettorConfigFromEnv(): AutoBettorConfig {
  const leaguesRaw = process.env.BETTING_LEAGUES ?? "LCK,LCS,LEC,LPL";

  return {
    enabled: process.env.BETTING_ENABLED === "true",
    bankroll: toNumber(process.env.BETTING_BANKROLL, 500),
    minEdge: toNumber(process.env.BETTING_MIN_EDGE, 0.08),
    maxBetFraction: toNumber(process.env.BETTING_MAX_BET_FRACTION, 0.05),
    maxDailyBets: toNumber(process.env.BETTING_MAX_DAILY_BETS, 3),
    maxDailyLoss: toNumber(process.env.BETTING_MAX_DAILY_LOSS, 50),
    betSizing: process.env.BETTING_SIZING === "flat" ? "flat" : "kelly",
    flatBetSize: toNumber(process.env.BETTING_FLAT_BET_SIZE, 10),
    dryRun: process.env.BETTING_DRY_RUN !== "false",
    leagues: leaguesRaw
      .split(",")
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry.length > 0),
  };
}
