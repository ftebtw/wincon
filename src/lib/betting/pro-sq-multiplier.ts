import { desc } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export interface ChampionMultiplier {
  champion: string;
  proToSqRatio: number;
  sampleSize: number;
  confidence: "high" | "medium" | "low";
}

const DEFAULT_MULTIPLIERS: ChampionMultiplier[] = [
  { champion: "Azir", proToSqRatio: 1.16, sampleSize: 220, confidence: "high" },
  { champion: "Corki", proToSqRatio: 1.19, sampleSize: 160, confidence: "high" },
  { champion: "Twisted Fate", proToSqRatio: 1.14, sampleSize: 180, confidence: "high" },
  { champion: "Orianna", proToSqRatio: 1.08, sampleSize: 210, confidence: "high" },
  { champion: "Kalista", proToSqRatio: 1.07, sampleSize: 140, confidence: "medium" },
  { champion: "Katarina", proToSqRatio: 0.86, sampleSize: 65, confidence: "medium" },
  { champion: "Master Yi", proToSqRatio: 0.82, sampleSize: 54, confidence: "medium" },
  { champion: "Yasuo", proToSqRatio: 0.9, sampleSize: 72, confidence: "medium" },
  { champion: "Nidalee", proToSqRatio: 1.09, sampleSize: 91, confidence: "medium" },
  { champion: "Rumble", proToSqRatio: 1.11, sampleSize: 74, confidence: "medium" },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeChampion(champion: string): string {
  return champion.trim().toLowerCase();
}

export class ProSqMultiplier {
  private multipliers = new Map<string, ChampionMultiplier>();
  private lastRecalculatedAt = 0;

  constructor(seed: ChampionMultiplier[] = DEFAULT_MULTIPLIERS) {
    for (const row of seed) {
      this.multipliers.set(normalizeChampion(row.champion), row);
    }
  }

  getAdjustedProWinRate(champion: string, currentSqWinRate: number): number {
    const multiplier = this.getMultiplier(champion);
    if (!multiplier || multiplier.confidence === "low") {
      return currentSqWinRate;
    }

    return clamp(currentSqWinRate * multiplier.proToSqRatio, 0.35, 0.75);
  }

  getMultiplier(champion: string): ChampionMultiplier | null {
    return this.multipliers.get(normalizeChampion(champion)) ?? null;
  }

  getAll(): ChampionMultiplier[] {
    return [...this.multipliers.values()].sort((a, b) => b.sampleSize - a.sampleSize);
  }

  async recalculateMultipliers(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastRecalculatedAt < 6 * 60 * 60 * 1000) {
      return;
    }

    const [proRows, sqRows] = await Promise.all([
      db
        .select({
          champion: schema.proPlayerStats.champion,
          result: schema.proPlayerStats.result,
        })
        .from(schema.proPlayerStats)
        .limit(100_000),
      db
        .select({
          championName: schema.championStats.championName,
          winRate: schema.championStats.winRate,
          gamesPlayed: schema.championStats.gamesPlayed,
          computedAt: schema.championStats.computedAt,
        })
        .from(schema.championStats)
        .orderBy(desc(schema.championStats.computedAt))
        .limit(5000),
    ]);

    const proByChampion = new Map<string, { wins: number; games: number }>();
    for (const row of proRows) {
      const key = normalizeChampion(row.champion);
      const current = proByChampion.get(key) ?? { wins: 0, games: 0 };
      current.games += 1;
      if (row.result) {
        current.wins += 1;
      }
      proByChampion.set(key, current);
    }

    const sqByChampion = new Map<string, { winRate: number; games: number }>();
    for (const row of sqRows) {
      const key = normalizeChampion(row.championName);
      if (sqByChampion.has(key)) {
        continue;
      }

      sqByChampion.set(key, {
        winRate: clamp(toNumber(row.winRate, 0.5), 0.35, 0.7),
        games: toNumber(row.gamesPlayed, 0),
      });
    }

    for (const [champion, proStats] of proByChampion.entries()) {
      if (proStats.games < 10) {
        continue;
      }

      const sq = sqByChampion.get(champion);
      if (!sq || sq.games < 20) {
        continue;
      }

      const proWr = proStats.wins / proStats.games;
      const ratio = clamp(proWr / Math.max(sq.winRate, 0.001), 0.7, 1.3);
      const confidence: ChampionMultiplier["confidence"] =
        proStats.games >= 50 ? "high" : proStats.games >= 20 ? "medium" : "low";

      this.multipliers.set(champion, {
        champion,
        proToSqRatio: ratio,
        sampleSize: proStats.games,
        confidence,
      });
    }

    this.lastRecalculatedAt = now;
  }
}

export const proSqMultiplier = new ProSqMultiplier();

