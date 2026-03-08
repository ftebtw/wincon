const POLYMARKET_API = "https://clob.polymarket.com";

import { PredictionModel } from "@/lib/betting/prediction-model";

export interface PolymarketMarket {
  conditionId: string;
  question: string;
  outcomes: string[];
  outcomePrices: number[];
  volume: number;
  liquidity: number;
  endDate: string;
}

export interface BettingOpportunity {
  market: PolymarketMarket;
  ourPrediction: number;
  marketImpliedProb: number;
  edge: number;
  kellySuggestedBet: number;
  side: "Yes" | "No";
  reasoning: string;
  predictionId?: number;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeMarkets(payload: unknown): PolymarketMarket[] {
  const root = payload as
    | { data?: unknown[]; markets?: unknown[] }
    | unknown[]
    | null
    | undefined;

  const rows = Array.isArray(root)
    ? root
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.markets)
        ? root.markets
        : [];

  return rows
    .map((row) => {
      const entry = row as Record<string, unknown>;
      const conditionId = String(entry.condition_id ?? entry.conditionId ?? "").trim();
      if (!conditionId) {
        return null;
      }

      const question = String(entry.question ?? entry.title ?? "");

      const outcomes = Array.isArray(entry.outcomes)
        ? entry.outcomes.map((item) => String(item))
        : ["Yes", "No"];

      const prices = Array.isArray(entry.outcomePrices)
        ? entry.outcomePrices.map((item) => toNumber(item, 0))
        : Array.isArray(entry.prices)
          ? entry.prices.map((item) => toNumber(item, 0))
          : [toNumber(entry.yes_price, 0.5), toNumber(entry.no_price, 0.5)];

      return {
        conditionId,
        question,
        outcomes,
        outcomePrices: prices,
        volume: toNumber(entry.volume, 0),
        liquidity: toNumber(entry.liquidity, 0),
        endDate: String(entry.end_date_iso ?? entry.endDate ?? ""),
      } satisfies PolymarketMarket;
    })
    .filter((entry): entry is PolymarketMarket => entry !== null);
}

export class PolymarketClient {
  private apiKey = process.env.POLYMARKET_API_KEY;
  private apiSecret = process.env.POLYMARKET_API_SECRET;
  private passphrase = process.env.POLYMARKET_PASSPHRASE;

  private async getJson(path: string): Promise<unknown> {
    const response = await fetch(`${POLYMARKET_API}${path}`, {
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Polymarket API request failed (${response.status})`);
    }

    return response.json();
  }

  async findLoLMarkets(): Promise<PolymarketMarket[]> {
    const payload = await this.getJson("/markets?active=true&closed=false&limit=500").catch(() => null);
    if (!payload) {
      return [];
    }

    const allMarkets = normalizeMarkets(payload);

    return allMarkets.filter((market) => {
      const normalized = market.question.toLowerCase();
      return (
        normalized.includes("league of legends") ||
        normalized.includes("lck") ||
        normalized.includes("lec") ||
        normalized.includes("lcs") ||
        normalized.includes("lpl") ||
        normalized.includes("msi") ||
        normalized.includes("worlds")
      );
    });
  }

  async getMarketOdds(conditionId: string): Promise<PolymarketMarket> {
    const payload = await this.getJson(`/markets/${encodeURIComponent(conditionId)}`);
    const markets = normalizeMarkets(payload);
    const market = markets.find((entry) => entry.conditionId === conditionId) ?? markets[0];

    if (!market) {
      throw new Error(`Market ${conditionId} not found.`);
    }

    return market;
  }

  async findOpportunities(model: PredictionModel, minEdge: number): Promise<BettingOpportunity[]> {
    const markets = await this.findLoLMarkets();
    const opportunities: BettingOpportunity[] = [];

    for (const market of markets) {
      const parsedTeams = this.parseMarketTeams(market.question);
      if (!parsedTeams) {
        continue;
      }

      const prediction = await model.predict({
        team1: parsedTeams.team1,
        team2: parsedTeams.team2,
        league: parsedTeams.league,
        side: { team1: "blue" },
        includePlayerForm: true,
      });

      const marketProb = market.outcomePrices[0] ?? 0.5;
      const edgeYes = prediction.team1WinProb - marketProb;
      const edgeNo = prediction.team2WinProb - (1 - marketProb);

      if (Math.abs(edgeYes) < minEdge && Math.abs(edgeNo) < minEdge) {
        continue;
      }

      const side: "Yes" | "No" = edgeYes >= edgeNo ? "Yes" : "No";
      const ourPrediction = side === "Yes" ? prediction.team1WinProb : prediction.team2WinProb;
      const implied = side === "Yes" ? marketProb : 1 - marketProb;
      const edge = ourPrediction - implied;

      opportunities.push({
        market,
        ourPrediction,
        marketImpliedProb: implied,
        edge,
        kellySuggestedBet: this.kellyBetSize(ourPrediction, implied, 100, 0.05),
        side,
        reasoning: `Model ${(ourPrediction * 100).toFixed(1)}% vs market ${(implied * 100).toFixed(1)}% (${(edge * 100).toFixed(1)}% edge).`,
      });
    }

    return opportunities.sort((a, b) => b.edge - a.edge);
  }

  async placeBet(params: {
    conditionId: string;
    side: "Yes" | "No";
    amount: number;
    price: number;
  }): Promise<{ orderId: string; status: string }> {
    if (!this.apiKey || !this.apiSecret || !this.passphrase) {
      throw new Error("Polymarket credentials are missing. Set POLYMARKET_API_KEY/SECRET/PASSPHRASE.");
    }

    const response = await fetch(`${POLYMARKET_API}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PM-API-KEY": this.apiKey,
        "PM-API-SECRET": this.apiSecret,
        "PM-API-PASSPHRASE": this.passphrase,
      },
      body: JSON.stringify({
        conditionId: params.conditionId,
        side: params.side,
        amount: params.amount,
        limitPrice: params.price,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to place Polymarket order (${response.status}).`);
    }

    const payload = (await response.json()) as Record<string, unknown>;

    return {
      orderId: String(payload.orderId ?? payload.id ?? "unknown"),
      status: String(payload.status ?? "submitted"),
    };
  }

  async getBetStatus(orderId: string): Promise<{ status: string; filled: number; remaining: number }> {
    const payload = await this.getJson(`/orders/${encodeURIComponent(orderId)}`);
    const row = payload as Record<string, unknown>;

    return {
      status: String(row.status ?? "unknown"),
      filled: toNumber(row.filled, 0),
      remaining: toNumber(row.remaining, 0),
    };
  }

  async getPortfolio(): Promise<{
    openBets: { market: string; side: string; amount: number; currentPrice: number; pnl: number }[];
    totalInvested: number;
    totalPnl: number;
    roi: number;
  }> {
    if (!this.apiKey || !this.apiSecret || !this.passphrase) {
      return {
        openBets: [],
        totalInvested: 0,
        totalPnl: 0,
        roi: 0,
      };
    }

    const payload = await this.getJson("/positions").catch(() => null);
    if (!payload) {
      return {
        openBets: [],
        totalInvested: 0,
        totalPnl: 0,
        roi: 0,
      };
    }

    const rows = Array.isArray((payload as { data?: unknown[] }).data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray(payload)
        ? (payload as unknown[])
        : [];

    const openBets = rows.map((entry) => {
      const row = entry as Record<string, unknown>;
      const amount = toNumber(row.size ?? row.amount, 0);
      const avgPrice = toNumber(row.avgPrice ?? row.average_price, 0);
      const mark = toNumber(row.markPrice ?? row.mark_price, avgPrice);
      const pnl = (mark - avgPrice) * amount;

      return {
        market: String(row.title ?? row.market ?? "Unknown market"),
        side: String(row.side ?? "Yes"),
        amount,
        currentPrice: mark,
        pnl,
      };
    });

    const totalInvested = openBets.reduce((sum, bet) => sum + bet.amount, 0);
    const totalPnl = openBets.reduce((sum, bet) => sum + bet.pnl, 0);

    return {
      openBets,
      totalInvested,
      totalPnl,
      roi: totalInvested > 0 ? totalPnl / totalInvested : 0,
    };
  }

  private parseMarketTeams(question: string): { team1: string; team2: string; league: string } | null {
    const cleaned = question.replace(/\s+/g, " ").trim();

    const versusMatch = cleaned.match(/([A-Za-z0-9.'-]+)\s+(?:vs\.?|versus)\s+([A-Za-z0-9.'-]+)/i);
    const willWinMatch = cleaned.match(/will\s+([A-Za-z0-9.'-]+)\s+beat\s+([A-Za-z0-9.'-]+)/i);

    const match = versusMatch ?? willWinMatch;
    if (!match) {
      return null;
    }

    const league = cleaned.toLowerCase().includes("lck")
      ? "LCK"
      : cleaned.toLowerCase().includes("lec")
        ? "LEC"
        : cleaned.toLowerCase().includes("lpl")
          ? "LPL"
          : cleaned.toLowerCase().includes("lcs")
            ? "LCS"
            : "LCK";

    return {
      team1: match[1],
      team2: match[2],
      league,
    };
  }

  private kellyBetSize(
    predictedProb: number,
    marketProb: number,
    bankroll: number,
    maxFraction: number,
  ): number {
    const b = (1 / marketProb) - 1;
    const p = predictedProb;
    const q = 1 - p;

    if (b <= 0) {
      return 0;
    }

    let fraction = (b * p - q) / b;
    fraction *= 0.5;
    fraction = clamp(fraction, 0, maxFraction);
    return bankroll * fraction;
  }
}

export { POLYMARKET_API };

