import { oddsClient } from "@/lib/betting/odds-api";
import { POLYMARKET_API } from "@/lib/betting/polymarket";

interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  timestamp: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number;
  midPrice: number;
  depth: { bidDepth: number; askDepth: number };
}

export interface Trade {
  timestamp: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  walletAddress: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIso(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return new Date().toISOString();
}

export class OrderFlowAnalyzer {
  private walletScoreCache = new Map<string, number>();

  async trackSmartWallets(conditionId: string): Promise<{
    smartMoneyFlow: "team1" | "team2" | "neutral";
    confidence: number;
    topWallets: {
      address: string;
      historicalAccuracy: number;
      betSize: number;
      side: string;
    }[];
  }> {
    const trades = await this.getRecentTrades(conditionId);
    if (trades.length === 0) {
      return {
        smartMoneyFlow: "neutral",
        confidence: 0,
        topWallets: [],
      };
    }

    const byWallet = new Map<
      string,
      { totalSize: number; yesExposure: number; noExposure: number; trades: number }
    >();
    for (const trade of trades) {
      const entry = byWallet.get(trade.walletAddress) ?? {
        totalSize: 0,
        yesExposure: 0,
        noExposure: 0,
        trades: 0,
      };
      entry.totalSize += trade.size;
      entry.trades += 1;
      if (trade.side === "buy") {
        entry.yesExposure += trade.size;
      } else {
        entry.noExposure += trade.size;
      }
      byWallet.set(trade.walletAddress, entry);
    }

    const topWallets = [...byWallet.entries()]
      .map(([address, entry]) => {
        const historicalAccuracy = this.scoreWallet(address, entry.totalSize, entry.trades);
        return {
          address,
          historicalAccuracy,
          betSize: entry.totalSize,
          side: entry.yesExposure >= entry.noExposure ? "team1" : "team2",
        };
      })
      .sort((a, b) => b.betSize * b.historicalAccuracy - a.betSize * a.historicalAccuracy)
      .slice(0, 5);

    const weightedFlow = topWallets.reduce((sum, wallet) => {
      const sign = wallet.side === "team1" ? 1 : -1;
      return sum + sign * wallet.betSize * wallet.historicalAccuracy;
    }, 0);

    const total = topWallets.reduce((sum, wallet) => sum + wallet.betSize, 0);
    const confidence = total > 0 ? clamp(Math.abs(weightedFlow) / total, 0, 1) : 0;
    const smartMoneyFlow =
      confidence < 0.1 ? "neutral" : weightedFlow >= 0 ? "team1" : "team2";

    return {
      smartMoneyFlow,
      confidence,
      topWallets,
    };
  }

  async getOrderBookImbalance(conditionId: string): Promise<{
    imbalanceRatio: number;
    predictedPriceDirection: "up" | "down" | "neutral";
    magnitude: number;
  }> {
    const snapshot = await this.getOrderBookSnapshot(conditionId);
    if (!snapshot) {
      return {
        imbalanceRatio: 1,
        predictedPriceDirection: "neutral",
        magnitude: 0,
      };
    }

    const ratio = snapshot.depth.askDepth <= 0
      ? 1.2
      : snapshot.depth.bidDepth / snapshot.depth.askDepth;

    const magnitude = clamp(Math.abs(ratio - 1), 0, 3);
    const predictedPriceDirection =
      magnitude < 0.08 ? "neutral" : ratio > 1 ? "up" : "down";

    return {
      imbalanceRatio: ratio,
      predictedPriceDirection,
      magnitude,
    };
  }

  async detectInformedTrading(conditionId: string): Promise<{
    detected: boolean;
    side: string;
    evidence: string;
  }> {
    const trades = await this.getRecentTrades(conditionId);
    if (trades.length === 0) {
      return {
        detected: false,
        side: "neutral",
        evidence: "No recent trade prints available.",
      };
    }

    const largest = [...trades].sort((a, b) => b.size - a.size)[0];
    const walletScore = this.scoreWallet(largest.walletAddress, largest.size, 1);
    const detected = largest.size >= 400 && walletScore >= 0.57;

    return {
      detected,
      side: largest.side === "buy" ? "team1" : "team2",
      evidence: detected
        ? `Large ${largest.side.toUpperCase()} trade ($${largest.size.toFixed(0)}) from high-score wallet (${(
            walletScore * 100
          ).toFixed(0)}% est).`
        : "No high-confidence informed trading signal.",
    };
  }

  async findCrossMarketArbitrage(
    fixtureId: string,
    polymarketConditionId: string,
  ): Promise<{
    pinnacleImpliedProb: number;
    polymarketPrice: number;
    difference: number;
    direction: string;
    edge: number;
  }> {
    const [fixtureOdds, snapshot] = await Promise.all([
      oddsClient.getFixtureOdds(fixtureId).catch(() => null),
      this.getOrderBookSnapshot(polymarketConditionId),
    ]);

    const best = fixtureOdds ? oddsClient.summarizeBestOdds(fixtureOdds) : null;
    const pinnacleProb =
      best?.pinnacle
        ? oddsClient.removeVig(best.pinnacle.homeOdds, best.pinnacle.awayOdds).home
        : fixtureOdds?.consensusProb.home ?? 0.5;

    const polymarketPrice = snapshot?.midPrice ?? 0.5;
    const difference = pinnacleProb - polymarketPrice;

    return {
      pinnacleImpliedProb: pinnacleProb,
      polymarketPrice,
      difference,
      direction: difference > 0 ? "team1_polymarket_undervalued" : "team2_polymarket_undervalued",
      edge: Math.abs(difference),
    };
  }

  private async getOrderBookSnapshot(conditionId: string): Promise<OrderBookSnapshot | null> {
    const urls = [
      `${POLYMARKET_API}/books/${encodeURIComponent(conditionId)}`,
      `${POLYMARKET_API}/book?conditionId=${encodeURIComponent(conditionId)}`,
    ];

    for (const url of urls) {
      const response = await fetch(url, { cache: "no-store" }).catch(() => null);
      if (!response || !response.ok) {
        continue;
      }
      const payload = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!payload) {
        continue;
      }

      const bids = this.parseLevels(payload.bids);
      const asks = this.parseLevels(payload.asks);
      if (bids.length === 0 || asks.length === 0) {
        continue;
      }

      const topBid = bids[0]?.price ?? 0.5;
      const topAsk = asks[0]?.price ?? 0.5;
      const bidDepth = bids.reduce((sum, level) => sum + level.size, 0);
      const askDepth = asks.reduce((sum, level) => sum + level.size, 0);

      return {
        timestamp: toIso(payload.timestamp),
        bids,
        asks,
        spread: Math.max(0, topAsk - topBid),
        midPrice: (topAsk + topBid) / 2,
        depth: { bidDepth, askDepth },
      };
    }

    return null;
  }

  private async getRecentTrades(conditionId: string): Promise<Trade[]> {
    const urls = [
      `${POLYMARKET_API}/trades?conditionId=${encodeURIComponent(conditionId)}&limit=200`,
      `${POLYMARKET_API}/history?conditionId=${encodeURIComponent(conditionId)}&limit=200`,
    ];

    for (const url of urls) {
      const response = await fetch(url, { cache: "no-store" }).catch(() => null);
      if (!response || !response.ok) {
        continue;
      }
      const payload = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!payload) {
        continue;
      }

      const rows = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.trades)
          ? payload.trades
          : [];

      const parsed = rows
        .map((row) => {
          const entry = (row ?? {}) as Record<string, unknown>;
          return {
            timestamp: toIso(entry.timestamp),
            side: String(entry.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy",
            price: clamp(toNumber(entry.price, 0.5), 0.01, 0.99),
            size: Math.max(0, toNumber(entry.size, toNumber(entry.amount, 0))),
            walletAddress: String(
              entry.walletAddress ?? entry.maker ?? entry.taker ?? "unknown",
            ),
          } as Trade;
        })
        .filter((trade) => trade.size > 0);

      if (parsed.length > 0) {
        return parsed;
      }
    }

    return [];
  }

  private parseLevels(raw: unknown): OrderBookLevel[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((entry) => {
        if (Array.isArray(entry)) {
          return {
            price: clamp(toNumber(entry[0], 0), 0.01, 0.99),
            size: Math.max(0, toNumber(entry[1], 0)),
          };
        }
        const level = (entry ?? {}) as Record<string, unknown>;
        return {
          price: clamp(toNumber(level.price, 0), 0.01, 0.99),
          size: Math.max(0, toNumber(level.size, 0)),
        };
      })
      .filter((level) => level.size > 0)
      .sort((a, b) => b.price - a.price)
      .slice(0, 30);
  }

  private scoreWallet(address: string, betSize: number, trades: number): number {
    if (this.walletScoreCache.has(address)) {
      return this.walletScoreCache.get(address) ?? 0.55;
    }

    // Heuristic bootstrap until we have richer on-chain wallet outcomes.
    const sizeScore = clamp(betSize / 2500, 0, 0.15);
    const tradeScore = clamp(trades / 40, 0, 0.08);
    const entropy = (Math.abs(this.hash(address)) % 13) / 100;
    const score = clamp(0.5 + sizeScore + tradeScore + entropy, 0.45, 0.72);

    this.walletScoreCache.set(address, score);
    return score;
  }

  private hash(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }
}

export const orderFlowAnalyzer = new OrderFlowAnalyzer();

