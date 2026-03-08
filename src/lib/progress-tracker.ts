import {
  and,
  desc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";

import { db, schema } from "@/lib/db";

export interface ProgressSnapshot {
  period: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  winRate: number;
  avgKDA: number;
  avgCSPerMin: number;
  avgVisionScore: number;
  avgDeathsBefor10: number;
  avgGoldDiffAt10: number;
  avgDamageShare: number;
  rank: string;
  lp: number;
  topPatterns: string[];
}

export interface RankPrediction {
  currentRank: string;
  predictedRank: string;
  confidence: "high" | "medium" | "low";
  gamesNeeded: number;
  reasoning: string;
}

export interface ProgressReport {
  current: ProgressSnapshot;
  previous: ProgressSnapshot;
  trends: {
    metric: string;
    current: number;
    previous: number;
    change: number;
    changePercent: number;
    direction: "improved" | "declined" | "stable";
    insight: string;
  }[];
  rankPrediction: RankPrediction;
  improvementScore: number;
  streaks: {
    currentWinStreak: number;
    currentLossStreak: number;
    bestWinStreak: number;
    worstLossStreak: number;
  };
}

type PeriodType = "week" | "month";

type SnapshotContext = {
  periodLabel: string;
  periodType: PeriodType;
  startMs: number;
  endMs: number;
};

type PlayerMatchRow = {
  matchId: string;
  teamId: number;
  role: string;
  puuid: string;
  damageDealt: number;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  visionScore: number;
  gameDuration: number;
  gameStartTs: number;
};

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
] as const;

const DIVISION_ORDER = ["IV", "III", "II", "I"] as const;

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRole(role: string): string {
  const normalized = role.trim().toUpperCase();
  if (normalized === "MIDDLE") {
    return "MID";
  }
  if (normalized === "BOTTOM") {
    return "ADC";
  }
  if (normalized === "UTILITY") {
    return "SUPPORT";
  }
  return normalized;
}

function isoWeek(date: Date): number {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  return Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function getPeriodContext(periodType: PeriodType, offset = 0): SnapshotContext {
  const now = new Date();

  if (periodType === "week") {
    const utcNow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = utcNow.getUTCDay() || 7;
    utcNow.setUTCDate(utcNow.getUTCDate() - (day - 1));
    utcNow.setUTCDate(utcNow.getUTCDate() - offset * 7);

    const start = new Date(Date.UTC(utcNow.getUTCFullYear(), utcNow.getUTCMonth(), utcNow.getUTCDate(), 0, 0, 0, 0));
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

    return {
      periodType,
      periodLabel: `${start.getUTCFullYear()}-W${String(isoWeek(start)).padStart(2, "0")}`,
      startMs: start.getTime(),
      endMs: end.getTime(),
    };
  }

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0, 0));

  return {
    periodType,
    periodLabel: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

function percentChange(current: number, previous: number): number {
  if (previous === 0) {
    if (current === 0) {
      return 0;
    }
    return 100;
  }

  return ((current - previous) / Math.abs(previous)) * 100;
}

function rankTierLpEstimates(tier: string): { gain: number; loss: number } {
  const normalizedTier = tier.toUpperCase();

  if (["IRON", "BRONZE", "SILVER", "GOLD"].includes(normalizedTier)) {
    return { gain: 25, loss: 18 };
  }

  if (["PLATINUM", "EMERALD"].includes(normalizedTier)) {
    return { gain: 21, loss: 20 };
  }

  return { gain: 17, loss: 21 };
}

function rankToPoints(rank: { tier: string; division?: string | null; lp: number }): number {
  const tierIndex = TIER_ORDER.indexOf(rank.tier as (typeof TIER_ORDER)[number]);
  const safeTierIndex = tierIndex >= 0 ? tierIndex : 0;

  if (safeTierIndex <= TIER_ORDER.indexOf("DIAMOND")) {
    const division = (rank.division ?? "IV").toUpperCase();
    const divisionIndex = DIVISION_ORDER.indexOf(division as (typeof DIVISION_ORDER)[number]);
    const safeDivision = divisionIndex >= 0 ? divisionIndex : 0;
    return safeTierIndex * 400 + safeDivision * 100 + rank.lp;
  }

  return safeTierIndex * 400 + rank.lp;
}

function pointsToRank(points: number): string {
  const clamped = Math.max(0, Math.floor(points));
  const diamondIndex = TIER_ORDER.indexOf("DIAMOND");

  if (clamped < (diamondIndex + 1) * 400) {
    const tierIndex = Math.min(TIER_ORDER.length - 1, Math.floor(clamped / 400));
    const tier = TIER_ORDER[tierIndex];
    const remainder = clamped - tierIndex * 400;
    const divisionIndex = Math.min(3, Math.floor(remainder / 100));
    const division = DIVISION_ORDER[divisionIndex];
    const lp = Math.max(0, remainder % 100);
    return `${tier} ${division} ${lp}LP`;
  }

  const tierIndex = Math.min(TIER_ORDER.length - 1, Math.floor(clamped / 400));
  const tier = TIER_ORDER[tierIndex];
  const lp = Math.max(0, clamped - tierIndex * 400);
  return `${tier} ${lp}LP`;
}

function formatCurrentRank(tier: string, division: string | null, lp: number): string {
  if (["MASTER", "GRANDMASTER", "CHALLENGER"].includes(tier.toUpperCase())) {
    return `${tier.toUpperCase()} ${lp}LP`;
  }

  return `${tier.toUpperCase()} ${(division ?? "IV").toUpperCase()} ${lp}LP`;
}

function computeStreaks(results: boolean[]): ProgressReport["streaks"] {
  if (results.length === 0) {
    return {
      currentWinStreak: 0,
      currentLossStreak: 0,
      bestWinStreak: 0,
      worstLossStreak: 0,
    };
  }

  let currentWin = 0;
  let currentLoss = 0;

  for (let index = results.length - 1; index >= 0; index -= 1) {
    const win = results[index];
    if (win) {
      if (currentLoss > 0) {
        break;
      }
      currentWin += 1;
    } else {
      if (currentWin > 0) {
        break;
      }
      currentLoss += 1;
    }
  }

  let bestWin = 0;
  let worstLoss = 0;
  let runningWin = 0;
  let runningLoss = 0;

  for (const result of results) {
    if (result) {
      runningWin += 1;
      bestWin = Math.max(bestWin, runningWin);
      runningLoss = 0;
    } else {
      runningLoss += 1;
      worstLoss = Math.max(worstLoss, runningLoss);
      runningWin = 0;
    }
  }

  return {
    currentWinStreak: currentWin,
    currentLossStreak: currentLoss,
    bestWinStreak: bestWin,
    worstLossStreak: worstLoss,
  };
}

function snapshotFromRow(row: typeof schema.progressSnapshots.$inferSelect): ProgressSnapshot {
  return {
    period: row.period,
    gamesPlayed: row.gamesPlayed ?? 0,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    winRate: toNumber(row.winRate),
    avgKDA: toNumber(row.avgKda),
    avgCSPerMin: toNumber(row.avgCsPerMin),
    avgVisionScore: toNumber(row.avgVisionScore),
    avgDeathsBefor10: toNumber(row.avgDeathsBefore10),
    avgGoldDiffAt10: toNumber(row.avgGoldDiffAt10),
    avgDamageShare: toNumber(row.avgDamageShare),
    rank: row.rank ?? "Unranked",
    lp: row.lp ?? 0,
    topPatterns: Array.isArray(row.topPatterns)
      ? row.topPatterns.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

export class ProgressTracker {
  private async getLatestMatchFetchedAt(params: {
    puuid: string;
    startMs: number;
    endMs: number;
  }): Promise<Date | null> {
    const rows = await db
      .select({
        fetchedAt: schema.matches.fetchedAt,
      })
      .from(schema.matchParticipants)
      .innerJoin(schema.matches, eq(schema.matchParticipants.matchId, schema.matches.matchId))
      .where(
        and(
          eq(schema.matchParticipants.puuid, params.puuid),
          eq(schema.matches.queueId, 420),
          sql`${schema.matches.gameStartTs} >= ${params.startMs}`,
          sql`${schema.matches.gameStartTs} < ${params.endMs}`,
        ),
      )
      .orderBy(desc(schema.matches.fetchedAt))
      .limit(1);

    return rows[0]?.fetchedAt ?? null;
  }

  async cacheSnapshot(puuid: string, snapshot: ProgressSnapshot): Promise<void> {
    const periodType: PeriodType = snapshot.period.includes("-W") ? "week" : "month";

    await db
      .insert(schema.progressSnapshots)
      .values({
        puuid,
        period: snapshot.period,
        periodType,
        gamesPlayed: snapshot.gamesPlayed,
        wins: snapshot.wins,
        losses: snapshot.losses,
        winRate: snapshot.winRate.toFixed(4),
        avgKda: snapshot.avgKDA.toFixed(2),
        avgCsPerMin: snapshot.avgCSPerMin.toFixed(2),
        avgVisionScore: snapshot.avgVisionScore.toFixed(1),
        avgDeathsBefore10: snapshot.avgDeathsBefor10.toFixed(1),
        avgGoldDiffAt10: snapshot.avgGoldDiffAt10.toFixed(0),
        avgDamageShare: snapshot.avgDamageShare.toFixed(4),
        rank: snapshot.rank,
        lp: snapshot.lp,
        topPatterns: snapshot.topPatterns,
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.progressSnapshots.puuid,
          schema.progressSnapshots.period,
          schema.progressSnapshots.periodType,
        ],
        set: {
          gamesPlayed: snapshot.gamesPlayed,
          wins: snapshot.wins,
          losses: snapshot.losses,
          winRate: snapshot.winRate.toFixed(4),
          avgKda: snapshot.avgKDA.toFixed(2),
          avgCsPerMin: snapshot.avgCSPerMin.toFixed(2),
          avgVisionScore: snapshot.avgVisionScore.toFixed(1),
          avgDeathsBefore10: snapshot.avgDeathsBefor10.toFixed(1),
          avgGoldDiffAt10: snapshot.avgGoldDiffAt10.toFixed(0),
          avgDamageShare: snapshot.avgDamageShare.toFixed(4),
          rank: snapshot.rank,
          lp: snapshot.lp,
          topPatterns: snapshot.topPatterns,
          computedAt: new Date(),
        },
      });
  }

  async computeSnapshot(
    puuid: string,
    period: PeriodType,
    offset = 0,
  ): Promise<ProgressSnapshot> {
    const context = getPeriodContext(period, offset);

    const cachedRows = await db
      .select()
      .from(schema.progressSnapshots)
      .where(
        and(
          eq(schema.progressSnapshots.puuid, puuid),
          eq(schema.progressSnapshots.period, context.periodLabel),
          eq(schema.progressSnapshots.periodType, period),
        ),
      )
      .limit(1);

    const cached = cachedRows[0];
    if (cached) {
      const latestFetchedAt = await this.getLatestMatchFetchedAt({
        puuid,
        startMs: context.startMs,
        endMs: context.endMs,
      });

      if (!latestFetchedAt || (cached.computedAt && cached.computedAt >= latestFetchedAt)) {
        return snapshotFromRow(cached);
      }
    }

    const playerRowsRaw = await db
      .select({
        matchId: schema.matchParticipants.matchId,
        teamId: schema.matchParticipants.teamId,
        role: schema.matchParticipants.role,
        puuid: schema.matchParticipants.puuid,
        damageDealt: schema.matchParticipants.damageDealt,
        win: schema.matchParticipants.win,
        kills: schema.matchParticipants.kills,
        deaths: schema.matchParticipants.deaths,
        assists: schema.matchParticipants.assists,
        cs: schema.matchParticipants.cs,
        visionScore: schema.matchParticipants.visionScore,
        gameDuration: schema.matches.gameDuration,
        gameStartTs: schema.matches.gameStartTs,
      })
      .from(schema.matchParticipants)
      .innerJoin(schema.matches, eq(schema.matchParticipants.matchId, schema.matches.matchId))
      .where(
        and(
          eq(schema.matchParticipants.puuid, puuid),
          eq(schema.matches.queueId, 420),
          sql`${schema.matches.gameStartTs} >= ${context.startMs}`,
          sql`${schema.matches.gameStartTs} < ${context.endMs}`,
        ),
      )
      .orderBy(schema.matches.gameStartTs);

    const playerRows: PlayerMatchRow[] = playerRowsRaw.map((row) => ({
      matchId: row.matchId,
      teamId: row.teamId,
      role: normalizeRole(row.role),
      puuid: row.puuid,
      damageDealt: row.damageDealt,
      win: row.win,
      kills: row.kills,
      deaths: row.deaths,
      assists: row.assists,
      cs: row.cs,
      visionScore: row.visionScore,
      gameDuration: row.gameDuration,
      gameStartTs: row.gameStartTs,
    }));

    const matchIds = Array.from(new Set(playerRows.map((row) => row.matchId)));

    let allMatchRows: Array<{
      matchId: string;
      puuid: string;
      teamId: number;
      role: string;
      damageDealt: number;
    }> = [];

    let frameRows: Array<{ matchId: string; puuid: string; gold: number }> = [];
    let earlyDeathRows: Array<{ matchId: string }> = [];

    if (matchIds.length > 0) {
      allMatchRows = await db
        .select({
          matchId: schema.matchParticipants.matchId,
          puuid: schema.matchParticipants.puuid,
          teamId: schema.matchParticipants.teamId,
          role: schema.matchParticipants.role,
          damageDealt: schema.matchParticipants.damageDealt,
        })
        .from(schema.matchParticipants)
        .where(inArray(schema.matchParticipants.matchId, matchIds));

      frameRows = await db
        .select({
          matchId: schema.timelineFrames.matchId,
          puuid: schema.timelineFrames.puuid,
          gold: schema.timelineFrames.gold,
        })
        .from(schema.timelineFrames)
        .where(
          and(
            inArray(schema.timelineFrames.matchId, matchIds),
            eq(schema.timelineFrames.frameMinute, 10),
          ),
        );

      earlyDeathRows = await db
        .select({
          matchId: schema.matchEvents.matchId,
        })
        .from(schema.matchEvents)
        .where(
          and(
            inArray(schema.matchEvents.matchId, matchIds),
            eq(schema.matchEvents.victimPuuid, puuid),
            eq(schema.matchEvents.eventType, "CHAMPION_KILL"),
            sql`${schema.matchEvents.timestampMs} < 600000`,
          ),
        );
    }

    const teamDamageMap = new Map<string, number>();
    const opponentsByMatch = new Map<string, Array<{ puuid: string; teamId: number; role: string }>>();

    for (const row of allMatchRows) {
      const teamKey = `${row.matchId}:${row.teamId}`;
      teamDamageMap.set(teamKey, (teamDamageMap.get(teamKey) ?? 0) + row.damageDealt);

      const existing = opponentsByMatch.get(row.matchId) ?? [];
      existing.push({
        puuid: row.puuid,
        teamId: row.teamId,
        role: normalizeRole(row.role),
      });
      opponentsByMatch.set(row.matchId, existing);
    }

    const goldAt10Map = new Map<string, number>();
    for (const frame of frameRows) {
      goldAt10Map.set(`${frame.matchId}:${frame.puuid}`, frame.gold);
    }

    const earlyDeathsByMatch = new Map<string, number>();
    for (const death of earlyDeathRows) {
      earlyDeathsByMatch.set(death.matchId, (earlyDeathsByMatch.get(death.matchId) ?? 0) + 1);
    }

    let totalKda = 0;
    let totalCsPerMin = 0;
    let totalVision = 0;
    let totalDeathsBefore10 = 0;
    let totalGoldDiffAt10 = 0;
    let goldDiffSamples = 0;
    let totalDamageShare = 0;

    const results: boolean[] = [];

    for (const row of playerRows) {
      const kda = row.deaths === 0 ? row.kills + row.assists : (row.kills + row.assists) / row.deaths;
      const csPerMin = row.gameDuration > 0 ? row.cs / (row.gameDuration / 60) : 0;
      const teamDamage = teamDamageMap.get(`${row.matchId}:${row.teamId}`) ?? 0;
      const damageShare = teamDamage > 0 ? row.damageDealt / teamDamage : 0;

      totalKda += kda;
      totalCsPerMin += csPerMin;
      totalVision += row.visionScore;
      totalDeathsBefore10 += earlyDeathsByMatch.get(row.matchId) ?? 0;
      totalDamageShare += damageShare;
      results.push(row.win);

      const matchParticipants = opponentsByMatch.get(row.matchId) ?? [];
      const opponent =
        matchParticipants.find(
          (candidate) =>
            candidate.teamId !== row.teamId && normalizeRole(candidate.role) === row.role,
        ) ?? matchParticipants.find((candidate) => candidate.teamId !== row.teamId);

      if (opponent) {
        const playerGold = goldAt10Map.get(`${row.matchId}:${row.puuid}`);
        const opponentGold = goldAt10Map.get(`${row.matchId}:${opponent.puuid}`);
        if (typeof playerGold === "number" && typeof opponentGold === "number") {
          totalGoldDiffAt10 += playerGold - opponentGold;
          goldDiffSamples += 1;
        }
      }
    }

    const gamesPlayed = playerRows.length;
    const wins = playerRows.filter((row) => row.win).length;
    const losses = Math.max(0, gamesPlayed - wins);

    const rankRows = await db
      .select({
        tier: schema.rankedStats.tier,
        rankDivision: schema.rankedStats.rankDivision,
        leaguePoints: schema.rankedStats.leaguePoints,
      })
      .from(schema.rankedStats)
      .where(
        and(
          eq(schema.rankedStats.puuid, puuid),
          eq(schema.rankedStats.queueType, "RANKED_SOLO_5x5"),
        ),
      )
      .orderBy(desc(schema.rankedStats.fetchedAt))
      .limit(1);

    const rankRow = rankRows[0];
    const rank = rankRow
      ? formatCurrentRank(rankRow.tier, rankRow.rankDivision, rankRow.leaguePoints)
      : "Unranked";
    const rankPoints = rankRow
      ? rankToPoints({
          tier: rankRow.tier,
          division: rankRow.rankDivision,
          lp: rankRow.leaguePoints,
        })
      : 0;

    const patternRows = await db
      .select({
        patternType: schema.playerPatterns.patternType,
        frequency: schema.playerPatterns.frequency,
        matchIds: schema.playerPatterns.matchIds,
      })
      .from(schema.playerPatterns)
      .where(eq(schema.playerPatterns.puuid, puuid));

    const matchIdSet = new Set(matchIds);
    const topPatterns = patternRows
      .map((row) => {
        const rowMatchIds = Array.isArray(row.matchIds)
          ? row.matchIds.filter((entry): entry is string => typeof entry === "string")
          : [];

        const overlap = rowMatchIds.filter((matchId) => matchIdSet.has(matchId)).length;
        const score = overlap * Math.max(0.01, toNumber(row.frequency));

        return {
          pattern: row.patternType,
          score,
          overlap,
        };
      })
      .filter((entry) => entry.overlap > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((entry) => entry.pattern);

    const snapshot: ProgressSnapshot = {
      period: context.periodLabel,
      gamesPlayed,
      wins,
      losses,
      winRate: gamesPlayed > 0 ? wins / gamesPlayed : 0,
      avgKDA: gamesPlayed > 0 ? totalKda / gamesPlayed : 0,
      avgCSPerMin: gamesPlayed > 0 ? totalCsPerMin / gamesPlayed : 0,
      avgVisionScore: gamesPlayed > 0 ? totalVision / gamesPlayed : 0,
      avgDeathsBefor10: gamesPlayed > 0 ? totalDeathsBefore10 / gamesPlayed : 0,
      avgGoldDiffAt10: goldDiffSamples > 0 ? totalGoldDiffAt10 / goldDiffSamples : 0,
      avgDamageShare: gamesPlayed > 0 ? totalDamageShare / gamesPlayed : 0,
      rank,
      lp: rankPoints,
      topPatterns,
    };

    await this.cacheSnapshot(puuid, snapshot);
    return snapshot;
  }

  async predictRank(puuid: string): Promise<RankPrediction> {
    const rankRows = await db
      .select({
        tier: schema.rankedStats.tier,
        rankDivision: schema.rankedStats.rankDivision,
        leaguePoints: schema.rankedStats.leaguePoints,
      })
      .from(schema.rankedStats)
      .where(
        and(
          eq(schema.rankedStats.puuid, puuid),
          eq(schema.rankedStats.queueType, "RANKED_SOLO_5x5"),
        ),
      )
      .orderBy(desc(schema.rankedStats.fetchedAt))
      .limit(1);

    const rankRow = rankRows[0];
    if (!rankRow) {
      return {
        currentRank: "Unranked",
        predictedRank: "Unranked",
        confidence: "low",
        gamesNeeded: 0,
        reasoning: "Not enough ranked data to project progression yet.",
      };
    }

    const recentRows = await db
      .select({
        win: schema.matchParticipants.win,
      })
      .from(schema.matchParticipants)
      .innerJoin(schema.matches, eq(schema.matchParticipants.matchId, schema.matches.matchId))
      .where(
        and(
          eq(schema.matchParticipants.puuid, puuid),
          eq(schema.matches.queueId, 420),
        ),
      )
      .orderBy(desc(schema.matches.gameStartTs))
      .limit(50);

    const recent20 = recentRows.slice(0, 20);
    const winRate20 =
      recent20.length > 0
        ? recent20.filter((row) => row.win).length / recent20.length
        : 0.5;
    const winRate50 =
      recentRows.length > 0
        ? recentRows.filter((row) => row.win).length / recentRows.length
        : winRate20;

    const estimates = rankTierLpEstimates(rankRow.tier);
    const avgLPPerGame = winRate20 * estimates.gain - (1 - winRate20) * estimates.loss;

    const currentRank = formatCurrentRank(
      rankRow.tier,
      rankRow.rankDivision,
      rankRow.leaguePoints,
    );

    const currentPoints = rankToPoints({
      tier: rankRow.tier,
      division: rankRow.rankDivision,
      lp: rankRow.leaguePoints,
    });

    const projectedPoints = currentPoints + avgLPPerGame * 50;
    const predictedRank = pointsToRank(projectedPoints);

    const gamesNeeded =
      avgLPPerGame > 0
        ? Math.ceil(Math.max(0, 100 - rankRow.leaguePoints) / avgLPPerGame)
        : 999;

    const confidence: RankPrediction["confidence"] =
      recentRows.length >= 40 ? "high" : recentRows.length >= 20 ? "medium" : "low";

    const trendWord = winRate20 >= winRate50 ? "improving" : "declining";
    const reasoning =
      avgLPPerGame > 0
        ? `Recent WR is ${(winRate20 * 100).toFixed(1)}% (50-game ${(winRate50 * 100).toFixed(1)}%, ${trendWord}). Estimated LP/game: ${avgLPPerGame.toFixed(2)}.`
        : `Recent WR is ${(winRate20 * 100).toFixed(1)}% (50-game ${(winRate50 * 100).toFixed(1)}%, ${trendWord}). Current trajectory is losing LP on average.`;

    return {
      currentRank,
      predictedRank,
      confidence,
      gamesNeeded,
      reasoning,
    };
  }

  async generateReport(puuid: string, period: PeriodType): Promise<ProgressReport> {
    const [current, previous, rankPrediction] = await Promise.all([
      this.computeSnapshot(puuid, period, 0),
      this.computeSnapshot(puuid, period, 1),
      this.predictRank(puuid),
    ]);

    const trendConfig: Array<{
      key: string;
      current: number;
      previous: number;
      higherIsBetter: boolean;
      insightLabel: string;
      formatter: (value: number) => string;
    }> = [
      {
        key: "win_rate",
        current: current.winRate,
        previous: previous.winRate,
        higherIsBetter: true,
        insightLabel: "Win rate",
        formatter: (value) => `${(value * 100).toFixed(1)}%`,
      },
      {
        key: "kda",
        current: current.avgKDA,
        previous: previous.avgKDA,
        higherIsBetter: true,
        insightLabel: "KDA",
        formatter: (value) => value.toFixed(2),
      },
      {
        key: "cs_per_min",
        current: current.avgCSPerMin,
        previous: previous.avgCSPerMin,
        higherIsBetter: true,
        insightLabel: "CS/min",
        formatter: (value) => value.toFixed(2),
      },
      {
        key: "vision_score",
        current: current.avgVisionScore,
        previous: previous.avgVisionScore,
        higherIsBetter: true,
        insightLabel: "Vision score",
        formatter: (value) => value.toFixed(1),
      },
      {
        key: "deaths_before_10",
        current: current.avgDeathsBefor10,
        previous: previous.avgDeathsBefor10,
        higherIsBetter: false,
        insightLabel: "Deaths before 10",
        formatter: (value) => value.toFixed(2),
      },
      {
        key: "gold_diff_at_10",
        current: current.avgGoldDiffAt10,
        previous: previous.avgGoldDiffAt10,
        higherIsBetter: true,
        insightLabel: "Gold diff @10",
        formatter: (value) => `${value >= 0 ? "+" : ""}${Math.round(value)}`,
      },
    ];

    const trends = trendConfig.map((metric) => {
      const change = metric.current - metric.previous;
      const changePercent = percentChange(metric.current, metric.previous);

      const direction: "improved" | "declined" | "stable" =
        Math.abs(change) < 0.001
          ? "stable"
          : metric.higherIsBetter
            ? change > 0
              ? "improved"
              : "declined"
            : change < 0
              ? "improved"
              : "declined";

      let insight = `${metric.insightLabel} is stable versus last period.`;
      if (direction === "improved") {
        insight = `${metric.insightLabel} improved to ${metric.formatter(metric.current)}.`;
      } else if (direction === "declined") {
        insight = `${metric.insightLabel} declined to ${metric.formatter(metric.current)}.`;
      }

      return {
        metric: metric.key,
        current: metric.current,
        previous: metric.previous,
        change,
        changePercent,
        direction,
        insight,
      };
    });

    const streakRows = await db
      .select({
        win: schema.matchParticipants.win,
      })
      .from(schema.matchParticipants)
      .innerJoin(schema.matches, eq(schema.matchParticipants.matchId, schema.matches.matchId))
      .where(
        and(
          eq(schema.matchParticipants.puuid, puuid),
          eq(schema.matches.queueId, 420),
          sql`${schema.matches.gameStartTs} >= ${getPeriodContext(period, 0).startMs}`,
          sql`${schema.matches.gameStartTs} < ${getPeriodContext(period, 0).endMs}`,
        ),
      )
      .orderBy(schema.matches.gameStartTs);

    const streaks = computeStreaks(streakRows.map((row) => row.win));

    let score = 50;
    for (const trend of trends) {
      if (trend.direction === "improved") {
        score += 8;
      } else if (trend.direction === "declined") {
        score -= 8;
      }

      score += Math.max(-5, Math.min(5, trend.changePercent / 10));
    }

    score += (current.winRate - 0.5) * 30;
    const improvementScore = Math.max(0, Math.min(100, Math.round(score)));

    return {
      current,
      previous,
      trends,
      rankPrediction,
      improvementScore,
      streaks,
    };
  }

  async getProgressTimeline(puuid: string, weeks: number): Promise<ProgressSnapshot[]> {
    const boundedWeeks = Math.max(2, Math.min(24, weeks));
    const snapshots: ProgressSnapshot[] = [];

    for (let offset = boundedWeeks - 1; offset >= 0; offset -= 1) {
      const snapshot = await this.computeSnapshot(puuid, "week", offset);
      snapshots.push(snapshot);
    }

    return snapshots;
  }
}

export const progressTracker = new ProgressTracker();
