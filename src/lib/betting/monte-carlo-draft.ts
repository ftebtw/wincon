import { and, desc, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { opggClient } from "@/lib/opgg-mcp";

import { soloQueueSpy } from "./solo-queue-spy";

export interface PlayerChampionPool {
  player: string;
  role: string;
  champions: {
    champion: string;
    weight: number;
    winRate: number;
    games: number;
  }[];
}

export interface DraftSimulation {
  team1Picks: string[];
  team2Picks: string[];
  bans: string[];
  probability: number;
  winProbability: number;
}

type TeamContext = {
  teamName: string;
  pools: PlayerChampionPool[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function randomWeighted<T>(items: T[], weight: (item: T) => number): T | null {
  if (items.length === 0) {
    return null;
  }

  const total = items.reduce((sum, item) => sum + Math.max(0, weight(item)), 0);
  if (total <= 0) {
    return items[Math.floor(Math.random() * items.length)] ?? null;
  }

  let target = Math.random() * total;
  for (const item of items) {
    target -= Math.max(0, weight(item));
    if (target <= 0) {
      return item;
    }
  }

  return items[items.length - 1] ?? null;
}

function buildDistribution(values: number[]): { range: string; frequency: number }[] {
  const buckets = [
    [0, 0.45, "<45%"],
    [0.45, 0.5, "45-50%"],
    [0.5, 0.55, "50-55%"],
    [0.55, 0.6, "55-60%"],
    [0.6, 0.65, "60-65%"],
    [0.65, 1, "65%+"],
  ] as const;

  return buckets.map(([start, end, label]) => {
    const count = values.filter((value) => value >= start && value < end).length;
    return {
      range: label,
      frequency: values.length > 0 ? count / values.length : 0,
    };
  });
}

function championList(pool: TeamContext): string[] {
  return pool.pools.flatMap((entry) => entry.champions.map((item) => item.champion));
}

function championWeight(pool: TeamContext, champion: string): number {
  const weights = pool.pools
    .flatMap((entry) => entry.champions)
    .filter((entry) => entry.champion === champion)
    .map((entry) => entry.weight);
  if (weights.length === 0) {
    return 0.2;
  }
  return Math.max(...weights);
}

export class MonteCarloDraftSimulator {
  async simulate(
    team1: string,
    team2: string,
    numSimulations = 10000,
  ): Promise<{
    team1ExpectedWinProb: number;
    team2ExpectedWinProb: number;
    standardDeviation: number;
    draftVolatility: number;
    bestCaseDraft: DraftSimulation;
    worstCaseDraft: DraftSimulation;
    distribution: { range: string; frequency: number }[];
  }> {
    const simulations: DraftSimulation[] = [];

    const [team1Context, team2Context] = await Promise.all([
      this.buildTeamContext(team1, team2),
      this.buildTeamContext(team2, team1),
    ]);

    const totalRuns = clamp(numSimulations, 100, 12000);
    for (let i = 0; i < totalRuns; i += 1) {
      const draft = this.simulateDraft(team1Context, team2Context);
      draft.winProbability = this.calculateDraftWinProb(
        draft.team1Picks,
        draft.team2Picks,
        team1Context,
        team2Context,
      );
      simulations.push(draft);
    }

    const winProbs = simulations.map((entry) => entry.winProbability);
    const mean = winProbs.reduce((sum, value) => sum + value, 0) / winProbs.length;
    const variance =
      winProbs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / winProbs.length;
    const stdDev = Math.sqrt(variance);

    const bestCaseDraft = simulations.reduce((best, current) =>
      current.winProbability > best.winProbability ? current : best,
    );
    const worstCaseDraft = simulations.reduce((worst, current) =>
      current.winProbability < worst.winProbability ? current : worst,
    );

    return {
      team1ExpectedWinProb: mean,
      team2ExpectedWinProb: 1 - mean,
      standardDeviation: stdDev,
      draftVolatility: clamp(stdDev / 0.15, 0, 1),
      bestCaseDraft,
      worstCaseDraft,
      distribution: buildDistribution(winProbs),
    };
  }

  private simulateDraft(team1: TeamContext, team2: TeamContext): DraftSimulation {
    const team1Picks: string[] = [];
    const team2Picks: string[] = [];
    const bans: string[] = [];
    const unavailable = new Set<string>();

    // Ban phase 1 + 2 (10 bans total)
    const banPattern = ["team1", "team2", "team1", "team2", "team1", "team2", "team2", "team1", "team2", "team1"] as const;
    for (const side of banPattern) {
      const source = side === "team1" ? team2 : team1;
      const candidate = randomWeighted(
        [...new Set(championList(source))].filter((champ) => !unavailable.has(champ)),
        (champion) => championWeight(source, champion),
      );
      if (!candidate) {
        continue;
      }
      bans.push(candidate);
      unavailable.add(candidate);
    }

    // Pick phase by role with weighted randomness and no duplicates.
    for (const roleIndex of [0, 1, 2, 3, 4]) {
      const blueCandidate = this.pickChampionForRole(
        team1,
        roleIndex,
        unavailable,
      );
      if (blueCandidate) {
        team1Picks.push(blueCandidate);
        unavailable.add(blueCandidate);
      }

      const redCandidate = this.pickChampionForRole(
        team2,
        roleIndex,
        unavailable,
      );
      if (redCandidate) {
        team2Picks.push(redCandidate);
        unavailable.add(redCandidate);
      }
    }

    while (team1Picks.length < 5) {
      const candidate = this.fallbackPick(team1, unavailable);
      if (!candidate) {
        break;
      }
      team1Picks.push(candidate);
      unavailable.add(candidate);
    }

    while (team2Picks.length < 5) {
      const candidate = this.fallbackPick(team2, unavailable);
      if (!candidate) {
        break;
      }
      team2Picks.push(candidate);
      unavailable.add(candidate);
    }

    const probability = this.estimateDraftLikelihood(team1, team2, team1Picks, team2Picks);

    return {
      team1Picks,
      team2Picks,
      bans,
      probability,
      winProbability: 0.5,
    };
  }

  private pickChampionForRole(
    team: TeamContext,
    roleIndex: number,
    unavailable: Set<string>,
  ): string | null {
    const pool = team.pools[roleIndex];
    if (!pool) {
      return this.fallbackPick(team, unavailable);
    }

    const candidate = randomWeighted(
      pool.champions.filter((entry) => !unavailable.has(entry.champion)),
      (entry) => entry.weight,
    );

    return candidate?.champion ?? this.fallbackPick(team, unavailable);
  }

  private fallbackPick(team: TeamContext, unavailable: Set<string>): string | null {
    const candidates = [...new Set(championList(team))].filter(
      (champion) => !unavailable.has(champion),
    );
    if (candidates.length === 0) {
      return null;
    }
    return randomWeighted(candidates, (champion) => championWeight(team, champion));
  }

  private calculateDraftWinProb(
    team1Picks: string[],
    team2Picks: string[],
    team1: TeamContext,
    team2: TeamContext,
  ): number {
    const team1Score = this.teamDraftScore(team1Picks, team1);
    const team2Score = this.teamDraftScore(team2Picks, team2);

    const matchupAdvantage = this.matchupEdge(team1Picks, team2Picks);
    const raw = team1Score - team2Score + matchupAdvantage;
    const logistic = 1 / (1 + Math.exp(-raw * 2.1));
    return clamp(logistic, 0.05, 0.95);
  }

  private teamDraftScore(picks: string[], team: TeamContext): number {
    if (picks.length === 0) {
      return 0.5;
    }

    let score = 0;
    for (const champion of picks) {
      const weight = championWeight(team, champion);
      score += weight;
    }

    return score / picks.length;
  }

  private matchupEdge(team1Picks: string[], team2Picks: string[]): number {
    const antiTank = new Set(["Vayne", "KogMaw", "Gwen", "Cassiopeia", "Azir"]);
    const engage = new Set(["Ornn", "Rakan", "Nautilus", "Leona", "Sejuani", "Vi"]);
    const poke = new Set(["Jayce", "Varus", "Xerath", "Ziggs", "Lux"]);
    const scaling = new Set(["Jinx", "Azir", "Kassadin", "Kayle", "Veigar"]);

    const t1Engage = team1Picks.filter((entry) => engage.has(entry)).length;
    const t2Engage = team2Picks.filter((entry) => engage.has(entry)).length;
    const t1Poke = team1Picks.filter((entry) => poke.has(entry)).length;
    const t2Poke = team2Picks.filter((entry) => poke.has(entry)).length;
    const t1Scaling = team1Picks.filter((entry) => scaling.has(entry)).length;
    const t2Scaling = team2Picks.filter((entry) => scaling.has(entry)).length;
    const t1AntiTank = team1Picks.filter((entry) => antiTank.has(entry)).length;
    const t2AntiTank = team2Picks.filter((entry) => antiTank.has(entry)).length;

    let edge = 0;
    if (t1Engage >= 2 && t2Poke >= 2) {
      edge += 0.05;
    }
    if (t2Engage >= 2 && t1Poke >= 2) {
      edge -= 0.05;
    }
    if (t1Scaling >= 2 && t2Scaling < 2) {
      edge += 0.03;
    }
    if (t2Scaling >= 2 && t1Scaling < 2) {
      edge -= 0.03;
    }
    if (t1AntiTank > t2AntiTank) {
      edge += 0.015;
    }
    if (t2AntiTank > t1AntiTank) {
      edge -= 0.015;
    }

    return clamp(edge, -0.15, 0.15);
  }

  private estimateDraftLikelihood(
    team1: TeamContext,
    team2: TeamContext,
    team1Picks: string[],
    team2Picks: string[],
  ): number {
    const t1 = team1Picks.reduce(
      (sum, champion) => sum + championWeight(team1, champion),
      0,
    );
    const t2 = team2Picks.reduce(
      (sum, champion) => sum + championWeight(team2, champion),
      0,
    );
    return clamp((t1 + t2) / 10, 0.0001, 1);
  }

  private async buildTeamContext(teamName: string, opponent: string): Promise<TeamContext> {
    const [pools, soloSignals, metaTier] = await Promise.all([
      this.getChampionPools(teamName),
      soloQueueSpy.scanTeamPractice(teamName, 7).catch(() => []),
      this.getMetaTierList(),
    ]);

    const signalBoosts = new Map<string, number>();
    for (const signal of soloSignals) {
      signalBoosts.set(signal.champion, 1 + signal.confidenceScore * 0.5);
    }

    const metaMap = new Map<string, number>();
    for (const row of metaTier) {
      metaMap.set(row.championName, row.score);
    }

    const boosted = pools.map((pool) => ({
      ...pool,
      champions: pool.champions
        .map((entry) => {
          const signal = signalBoosts.get(entry.champion) ?? 1;
          const meta = 1 + (metaMap.get(entry.champion) ?? 0) * 0.15;
          return {
            ...entry,
            weight: clamp(entry.weight * signal * meta, 0.01, 3),
          };
        })
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 20),
    }));

    // If we have no pools, fill from meta to keep simulation alive.
    if (boosted.length === 0) {
      const fallback = metaTier.slice(0, 40).map((entry) => ({
        champion: entry.championName,
        weight: clamp(0.8 + entry.score, 0.2, 2),
        winRate: entry.winRate,
        games: entry.sampleSize,
      }));
      return {
        teamName,
        pools: [0, 1, 2, 3, 4].map((idx) => ({
          player: `${teamName}-P${idx + 1}`,
          role: ["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"][idx] ?? "FLEX",
          champions: fallback,
        })),
      };
    }

    // Ensure exactly 5 role pools.
    const normalizedPools = [...boosted];
    while (normalizedPools.length < 5) {
      const copyFrom = normalizedPools[normalizedPools.length - 1];
      normalizedPools.push({
        player: `${teamName}-FLEX-${normalizedPools.length + 1}`,
        role: ["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"][normalizedPools.length] ?? "FLEX",
        champions: copyFrom?.champions ?? [],
      });
    }

    return {
      teamName: opponent ? teamName : teamName,
      pools: normalizedPools.slice(0, 5),
    };
  }

  private async getChampionPools(teamName: string): Promise<PlayerChampionPool[]> {
    const teamRows = await db
      .select({ teamId: schema.proTeams.id })
      .from(schema.proTeams)
      .where(eq(schema.proTeams.teamName, teamName))
      .limit(1);

    const teamId = teamRows[0]?.teamId;
    const roster = teamId
      ? await db
          .select({
            playerName: schema.proPlayers.playerName,
            role: schema.proPlayers.position,
          })
          .from(schema.proPlayers)
          .where(eq(schema.proPlayers.teamId, teamId))
          .limit(8)
      : [];

    const playerNames = roster.map((entry) => entry.playerName);
    const stats = playerNames.length
      ? await db
          .select({
            playerName: schema.proPlayerStats.playerName,
            champion: schema.proPlayerStats.champion,
            result: schema.proPlayerStats.result,
          })
          .from(schema.proPlayerStats)
          .where(inArray(schema.proPlayerStats.playerName, playerNames))
          .orderBy(desc(schema.proPlayerStats.id))
          .limit(2000)
      : [];

    const byPlayer = new Map<string, Map<string, { wins: number; games: number }>>();
    for (const row of stats) {
      const playerMap = byPlayer.get(row.playerName) ?? new Map();
      const championStats = playerMap.get(row.champion) ?? { wins: 0, games: 0 };
      championStats.games += 1;
      if (row.result) {
        championStats.wins += 1;
      }
      playerMap.set(row.champion, championStats);
      byPlayer.set(row.playerName, playerMap);
    }

    return roster
      .map((player) => {
        const champs = byPlayer.get(player.playerName) ?? new Map();
        const championRows = [...champs.entries()]
          .map(([champion, stat]) => {
            const wr = stat.games > 0 ? stat.wins / stat.games : 0.5;
            const weight = clamp(stat.games / 8, 0.2, 2) * (0.8 + wr);
            return {
              champion,
              weight,
              winRate: wr,
              games: stat.games,
            };
          })
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 20);

        return {
          player: player.playerName,
          role: player.role,
          champions: championRows,
        };
      })
      .filter((entry) => entry.champions.length > 0);
  }

  private async getMetaTierList(): Promise<
    { championName: string; score: number; winRate: number; sampleSize: number }[]
  > {
    const fromOpgg = await opggClient.getTierList().catch(() => null);
    if (fromOpgg?.champions && Array.isArray(fromOpgg.champions)) {
      return fromOpgg.champions.slice(0, 120).map((row) => ({
        championName: row.championName,
        score: row.tier === "1" ? 1 : row.tier === "2" ? 0.8 : row.tier === "3" ? 0.6 : 0.4,
        winRate: toNumber(row.winRate, 0.5),
        sampleSize: 1000,
      }));
    }

    const fallback = await db
      .select({
        championName: schema.championStats.championName,
        winRate: schema.championStats.winRate,
        gamesPlayed: schema.championStats.gamesPlayed,
      })
      .from(schema.championStats)
      .where(and(eq(schema.championStats.tier, "ALL")))
      .orderBy(desc(schema.championStats.computedAt))
      .limit(300);

    return fallback.map((entry) => ({
      championName: entry.championName,
      score: clamp((toNumber(entry.winRate, 0.5) - 0.45) * 8, 0.2, 1),
      winRate: toNumber(entry.winRate, 0.5),
      sampleSize: toNumber(entry.gamesPlayed, 100),
    }));
  }
}

export const monteCarloDraftSimulator = new MonteCarloDraftSimulator();

