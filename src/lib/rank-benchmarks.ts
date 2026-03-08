import { and, desc, eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export interface BenchmarkMetric {
  player: number;
  rankAvg: number;
  percentile: number;
}

export interface RankBenchmarks {
  csAt10: BenchmarkMetric;
  goldAt10: BenchmarkMetric;
  visionScore: BenchmarkMetric;
  deathsBefore10: BenchmarkMetric;
  damageShare: BenchmarkMetric;
  kda: BenchmarkMetric;
  csPerMin: BenchmarkMetric;
}

export interface PlayerMatchStats {
  csAt10: number;
  goldAt10: number;
  visionScore: number;
  deathsBefore10: number;
  damageShare: number;
  kda: number;
  csPerMin: number;
  tier?: string;
}

const TIER_ORDER = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "EMERALD",
  "DIAMOND",
  "MASTER",
  "GRANDMASTER",
  "CHALLENGER",
];

const DEFAULT_ROLE_BASELINES: Record<
  string,
  {
    csAt10: number;
    goldAt10: number;
    visionScore: number;
    deathsBefore10: number;
    damageShare: number;
    kda: number;
    csPerMin: number;
  }
> = {
  TOP: {
    csAt10: 72,
    goldAt10: 3500,
    visionScore: 18,
    deathsBefore10: 0.8,
    damageShare: 0.23,
    kda: 2.8,
    csPerMin: 6.8,
  },
  JUNGLE: {
    csAt10: 54,
    goldAt10: 3300,
    visionScore: 24,
    deathsBefore10: 0.6,
    damageShare: 0.21,
    kda: 3.2,
    csPerMin: 5.8,
  },
  MID: {
    csAt10: 78,
    goldAt10: 3600,
    visionScore: 20,
    deathsBefore10: 0.7,
    damageShare: 0.27,
    kda: 3.1,
    csPerMin: 7.2,
  },
  ADC: {
    csAt10: 82,
    goldAt10: 3650,
    visionScore: 16,
    deathsBefore10: 0.7,
    damageShare: 0.29,
    kda: 3.5,
    csPerMin: 7.8,
  },
  SUPPORT: {
    csAt10: 14,
    goldAt10: 2500,
    visionScore: 30,
    deathsBefore10: 0.9,
    damageShare: 0.15,
    kda: 3.0,
    csPerMin: 1.5,
  },
};

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampPercentile(value: number): number {
  return Math.max(1, Math.min(99, Math.round(value)));
}

function estimatePercentile(params: {
  player: number;
  rankAvg: number;
  higherIsBetter: boolean;
}): number {
  if (!Number.isFinite(params.rankAvg) || params.rankAvg <= 0) {
    return 50;
  }

  const ratio = (params.player - params.rankAvg) / params.rankAvg;
  const signed = params.higherIsBetter ? ratio : -ratio;
  return clampPercentile(50 + signed * 35);
}

function normalizeRole(role: string): string {
  const normalized = role.trim().toUpperCase();
  if (normalized === "MIDDLE") return "MID";
  if (normalized === "UTILITY") return "SUPPORT";
  if (normalized === "BOTTOM") return "ADC";
  return normalized;
}

function tierStepUp(tier: string): string {
  const upper = tier.toUpperCase();
  const index = TIER_ORDER.indexOf(upper);
  if (index < 0 || index >= TIER_ORDER.length - 1) {
    return "CHALLENGER";
  }
  return TIER_ORDER[index + 1];
}

export class RankBenchmarkService {
  private async getChampionStatsRow(params: {
    championName: string;
    role: string;
    tier: string;
  }) {
    if (!process.env.DATABASE_URL) {
      return null;
    }

    const normalizedRole = normalizeRole(params.role);
    const championName = params.championName.trim();
    const tier = params.tier.toUpperCase();

    const preferred = await db
      .select()
      .from(schema.championStats)
      .where(
        and(
          eq(schema.championStats.role, normalizedRole),
          eq(schema.championStats.tier, tier),
          sql`lower(${schema.championStats.championName}) = lower(${championName})`,
        ),
      )
      .orderBy(desc(schema.championStats.computedAt))
      .limit(1);
    if (preferred[0]) {
      return preferred[0];
    }

    const fallbackTier = await db
      .select()
      .from(schema.championStats)
      .where(
        and(
          eq(schema.championStats.role, normalizedRole),
          eq(schema.championStats.tier, "ALL"),
          sql`lower(${schema.championStats.championName}) = lower(${championName})`,
        ),
      )
      .orderBy(desc(schema.championStats.computedAt))
      .limit(1);
    return fallbackTier[0] ?? null;
  }

  async getBenchmarks(
    championName: string,
    role: string,
    tier: string,
    playerStats: PlayerMatchStats,
  ): Promise<RankBenchmarks> {
    const normalizedRole = normalizeRole(role);
    const baseline = DEFAULT_ROLE_BASELINES[normalizedRole] ?? DEFAULT_ROLE_BASELINES.MID;

    const row = await this.getChampionStatsRow({
      championName,
      role: normalizedRole,
      tier,
    });

    const avgKills = toNumber(row?.avgKills, 6);
    const avgDeaths = Math.max(1, toNumber(row?.avgDeaths, 4));
    const avgAssists = toNumber(row?.avgAssists, 7);
    const avgKda = (avgKills + avgAssists) / avgDeaths;

    const avgCsAt10 = toNumber(row?.avgCsAt10, baseline.csAt10);
    const avgGoldAt10 = toNumber(row?.avgGoldAt10, baseline.goldAt10);
    const avgVisionScore = toNumber(row?.avgVisionScore, baseline.visionScore);
    const avgDeathsBefore10 = Math.max(
      0.1,
      toNumber(row?.avgDeaths, baseline.deathsBefore10 * 2) * 0.35,
    );
    const avgDamageShare = baseline.damageShare;
    const avgCsPerMin = toNumber(row?.avgCs, baseline.csPerMin * 30) / 30;

    return {
      csAt10: {
        player: playerStats.csAt10,
        rankAvg: avgCsAt10,
        percentile: estimatePercentile({
          player: playerStats.csAt10,
          rankAvg: avgCsAt10,
          higherIsBetter: true,
        }),
      },
      goldAt10: {
        player: playerStats.goldAt10,
        rankAvg: avgGoldAt10,
        percentile: estimatePercentile({
          player: playerStats.goldAt10,
          rankAvg: avgGoldAt10,
          higherIsBetter: true,
        }),
      },
      visionScore: {
        player: playerStats.visionScore,
        rankAvg: avgVisionScore,
        percentile: estimatePercentile({
          player: playerStats.visionScore,
          rankAvg: avgVisionScore,
          higherIsBetter: true,
        }),
      },
      deathsBefore10: {
        player: playerStats.deathsBefore10,
        rankAvg: avgDeathsBefore10,
        percentile: estimatePercentile({
          player: playerStats.deathsBefore10,
          rankAvg: avgDeathsBefore10,
          higherIsBetter: false,
        }),
      },
      damageShare: {
        player: playerStats.damageShare,
        rankAvg: avgDamageShare,
        percentile: estimatePercentile({
          player: playerStats.damageShare,
          rankAvg: avgDamageShare,
          higherIsBetter: true,
        }),
      },
      kda: {
        player: playerStats.kda,
        rankAvg: avgKda || baseline.kda,
        percentile: estimatePercentile({
          player: playerStats.kda,
          rankAvg: avgKda || baseline.kda,
          higherIsBetter: true,
        }),
      },
      csPerMin: {
        player: playerStats.csPerMin,
        rankAvg: avgCsPerMin || baseline.csPerMin,
        percentile: estimatePercentile({
          player: playerStats.csPerMin,
          rankAvg: avgCsPerMin || baseline.csPerMin,
          higherIsBetter: true,
        }),
      },
    };
  }

  async getMultiRankBenchmarks(
    championName: string,
    role: string,
    playerStats: PlayerMatchStats,
  ): Promise<{
    playerTier: RankBenchmarks;
    oneTierUp: RankBenchmarks;
    challenger: RankBenchmarks;
  }> {
    const playerTier = (playerStats.tier ?? "EMERALD").toUpperCase();
    const upTier = tierStepUp(playerTier);

    const [playerTierBenchmarks, oneTierUpBenchmarks, challengerBenchmarks] =
      await Promise.all([
        this.getBenchmarks(championName, role, playerTier, playerStats),
        this.getBenchmarks(championName, role, upTier, playerStats),
        this.getBenchmarks(championName, role, "CHALLENGER", playerStats),
      ]);

    return {
      playerTier: playerTierBenchmarks,
      oneTierUp: oneTierUpBenchmarks,
      challenger: challengerBenchmarks,
    };
  }
}

export const rankBenchmarkService = new RankBenchmarkService();
