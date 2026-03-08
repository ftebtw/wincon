import { and, desc, eq, gte, inArray, or } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export interface CoachFingerprint {
  coachName: string;
  currentTeam: string;
  draftProfile: {
    banPriority: string[];
    firstPickPriority: string[];
    flexPickRate: number;
    comfortOverMeta: number;
    cheeseRate: number;
    blueSideFirstPick: string[];
    redSideResponsePicks: string[];
  };
  playstyleProfile: {
    aggressionLevel: number;
    objectivePriority: "dragon" | "herald" | "balanced";
    averageGameDuration: number;
    firstBloodRate: number;
    visionScore: number;
    teamfightVsSplitpush: number;
  };
  adaptationProfile: {
    midSeriesAdaptation: number;
    patchAdaptationSpeed: number;
    counterStrategyEffectiveness: number;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class CoachAnalyzer {
  async buildFingerprint(coachName: string): Promise<CoachFingerprint> {
    const teamName = await this.resolveCurrentTeam(coachName);

    const [teamMatches, playerStats] = await Promise.all([
      db
        .select({
          gameId: schema.proMatches.gameId,
          blueTeam: schema.proMatches.blueTeam,
          redTeam: schema.proMatches.redTeam,
          winner: schema.proMatches.winner,
          gameDuration: schema.proMatches.gameDuration,
        })
        .from(schema.proMatches)
        .where(
          or(
            eq(schema.proMatches.blueTeam, teamName),
            eq(schema.proMatches.redTeam, teamName),
          ),
        )
        .orderBy(desc(schema.proMatches.date))
        .limit(300),
      db
        .select({
          gameId: schema.proPlayerStats.gameId,
          teamName: schema.proPlayerStats.teamName,
          champion: schema.proPlayerStats.champion,
          kills: schema.proPlayerStats.kills,
          deaths: schema.proPlayerStats.deaths,
          firstBlood: schema.proPlayerStats.firstBlood,
          dragons: schema.proPlayerStats.dragons,
          firstDragon: schema.proPlayerStats.firstDragon,
          firstBaron: schema.proPlayerStats.firstBaron,
          firstTower: schema.proPlayerStats.firstTower,
          visionScore: schema.proPlayerStats.visionScore,
          position: schema.proPlayerStats.position,
          side: schema.proPlayerStats.side,
        })
        .from(schema.proPlayerStats)
        .where(eq(schema.proPlayerStats.teamName, teamName))
        .orderBy(desc(schema.proPlayerStats.id))
        .limit(3000),
    ]);

    const gameIds = [...new Set(
      playerStats
        .map((entry) => entry.gameId)
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    )];
    const teamStatsRows = gameIds.length
      ? await db
          .select({
            gameId: schema.proPlayerStats.gameId,
            champion: schema.proPlayerStats.champion,
            position: schema.proPlayerStats.position,
            side: schema.proPlayerStats.side,
          })
          .from(schema.proPlayerStats)
          .where(
            and(
              inArray(schema.proPlayerStats.gameId, gameIds),
              eq(schema.proPlayerStats.teamName, teamName),
            ),
          )
      : [];

    const byGame = new Map<string, typeof teamStatsRows>();
    for (const row of teamStatsRows) {
      const list = byGame.get(row.gameId ?? "") ?? [];
      list.push(row);
      byGame.set(row.gameId ?? "", list);
    }

    const firstPickCount = new Map<string, number>();
    const blueFirstPickCount = new Map<string, number>();
    const redResponseCount = new Map<string, number>();

    let flexPicks = 0;
    let cheesePicks = 0;
    let totalPicks = 0;
    let firstBloodGames = 0;
    let dragonPriority = 0;
    let heraldPriority = 0;
    let visionTotal = 0;
    let teamfightBias = 0;

    for (const [gameId, picks] of byGame.entries()) {
      const ordered = picks.slice(0, 5);
      const first = ordered[0]?.champion;
      if (first) {
        firstPickCount.set(first, (firstPickCount.get(first) ?? 0) + 1);
      }

      const side = ordered[0]?.side ?? "Blue";
      if (first && side.toLowerCase().includes("blue")) {
        blueFirstPickCount.set(first, (blueFirstPickCount.get(first) ?? 0) + 1);
      }
      if (first && side.toLowerCase().includes("red")) {
        redResponseCount.set(first, (redResponseCount.get(first) ?? 0) + 1);
      }

      const byChampion = new Set(ordered.map((entry) => entry.champion));
      if (byChampion.size < ordered.length) {
        flexPicks += 1;
      }

      for (const pick of ordered) {
        totalPicks += 1;
        if (this.isCheeseChampion(pick.champion)) {
          cheesePicks += 1;
        }
      }

      const gameStats = playerStats.filter((entry) => entry.gameId === gameId);
      if (gameStats.some((entry) => entry.firstBlood)) {
        firstBloodGames += 1;
      }
      if (gameStats.some((entry) => parseBool(entry.firstDragon))) {
        dragonPriority += 1;
      }
      if (gameStats.some((entry) => parseBool(entry.firstBaron))) {
        heraldPriority += 1;
      }

      visionTotal +=
        gameStats.reduce((sum, entry) => sum + toNumber(entry.visionScore, 0), 0) /
        Math.max(1, gameStats.length);

      const kills = gameStats.reduce((sum, entry) => sum + toNumber(entry.kills, 0), 0);
      const deaths = gameStats.reduce((sum, entry) => sum + toNumber(entry.deaths, 0), 0);
      teamfightBias += clamp((kills - deaths + 15) / 30, 0, 1);
    }

    const totalGames = Math.max(1, byGame.size);
    const avgDuration =
      teamMatches.length > 0
        ? teamMatches.reduce((sum, entry) => sum + toNumber(entry.gameDuration, 0), 0) /
          teamMatches.length
        : 1900;

    const draftProfile: CoachFingerprint["draftProfile"] = {
      banPriority: this.topKeys(firstPickCount, 5), // proxy until explicit ban data is added
      firstPickPriority: this.topKeys(firstPickCount, 5),
      flexPickRate: clamp(flexPicks / totalGames, 0, 1),
      comfortOverMeta: clamp(0.55 + (1 - clamp(cheesePicks / Math.max(1, totalPicks), 0, 1)) * 0.2, 0, 1),
      cheeseRate: clamp(cheesePicks / Math.max(1, totalPicks), 0, 1),
      blueSideFirstPick: this.topKeys(blueFirstPickCount, 4),
      redSideResponsePicks: this.topKeys(redResponseCount, 4),
    };

    const playstyleProfile: CoachFingerprint["playstyleProfile"] = {
      aggressionLevel: clamp(firstBloodGames / totalGames, 0, 1),
      objectivePriority:
        dragonPriority > heraldPriority + 4
          ? "dragon"
          : heraldPriority > dragonPriority + 4
            ? "herald"
            : "balanced",
      averageGameDuration: avgDuration,
      firstBloodRate: clamp(firstBloodGames / totalGames, 0, 1),
      visionScore: visionTotal / totalGames,
      teamfightVsSplitpush: clamp(teamfightBias / totalGames, 0, 1),
    };

    const adaptationProfile: CoachFingerprint["adaptationProfile"] = {
      midSeriesAdaptation: await this.estimateMidSeriesAdaptation(teamName),
      patchAdaptationSpeed: await this.estimatePatchAdaptation(teamName),
      counterStrategyEffectiveness: clamp(
        (await this.estimateMidSeriesAdaptation(teamName)) * 0.6 +
          (await this.estimatePatchAdaptation(teamName)) * 0.4,
        0,
        1,
      ),
    };

    return {
      coachName,
      currentTeam: teamName,
      draftProfile,
      playstyleProfile,
      adaptationProfile,
    };
  }

  async predictStyleShift(
    teamName: string,
    newCoach: string,
    previousCoach: string,
  ): Promise<{
    expectedChanges: {
      metric: string;
      oldValue: number;
      predictedNewValue: number;
      confidence: number;
    }[];
    overallImpact: number;
    transitionPeriod: number;
  }> {
    const [newPrint, oldPrint] = await Promise.all([
      this.buildFingerprint(newCoach),
      this.buildFingerprint(previousCoach),
    ]);

    const expectedChanges = [
      {
        metric: "aggressionLevel",
        oldValue: oldPrint.playstyleProfile.aggressionLevel,
        predictedNewValue: newPrint.playstyleProfile.aggressionLevel,
        confidence: 0.7,
      },
      {
        metric: "flexPickRate",
        oldValue: oldPrint.draftProfile.flexPickRate,
        predictedNewValue: newPrint.draftProfile.flexPickRate,
        confidence: 0.65,
      },
      {
        metric: "midSeriesAdaptation",
        oldValue: oldPrint.adaptationProfile.midSeriesAdaptation,
        predictedNewValue: newPrint.adaptationProfile.midSeriesAdaptation,
        confidence: 0.75,
      },
      {
        metric: "patchAdaptationSpeed",
        oldValue: oldPrint.adaptationProfile.patchAdaptationSpeed,
        predictedNewValue: newPrint.adaptationProfile.patchAdaptationSpeed,
        confidence: 0.7,
      },
    ];

    const overallImpact = clamp(
      expectedChanges.reduce(
        (sum, row) => sum + (row.predictedNewValue - row.oldValue) * row.confidence,
        0,
      ) * 0.2,
      -0.1,
      0.1,
    );

    // 2-4 weeks ~= 6-12 stage games, depending on schedule.
    const transitionPeriod = Math.round(
      clamp(10 - Math.abs(overallImpact) * 30, 6, 12),
    );

    return {
      expectedChanges,
      overallImpact,
      transitionPeriod,
    };
  }

  async getMatchupAdjustment(
    team1: string,
    team2: string,
  ): Promise<{ team1Adjustment: number; team2Adjustment: number; reason: string }> {
    const [team1Print, team2Print] = await Promise.all([
      this.buildFingerprint(team1),
      this.buildFingerprint(team2),
    ]);

    const adaptationDiff =
      team1Print.adaptationProfile.midSeriesAdaptation -
      team2Print.adaptationProfile.midSeriesAdaptation;
    const draftingDiff =
      team1Print.draftProfile.flexPickRate - team2Print.draftProfile.flexPickRate;

    const team1Adjustment = clamp(adaptationDiff * 0.03 + draftingDiff * 0.02, -0.05, 0.05);
    return {
      team1Adjustment,
      team2Adjustment: -team1Adjustment,
      reason: "Coach strategic fingerprint adjustment (draft flexibility + adaptation).",
    };
  }

  private async resolveCurrentTeam(coachName: string): Promise<string> {
    const coachRow = await db
      .select({
        teamName: schema.proTeams.teamName,
      })
      .from(schema.proPlayers)
      .leftJoin(schema.proTeams, eq(schema.proPlayers.teamId, schema.proTeams.id))
      .where(eq(schema.proPlayers.playerName, coachName))
      .limit(1);

    if (coachRow[0]?.teamName) {
      return coachRow[0].teamName;
    }

    // Fallback: treat provided name as team name if no explicit coach mapping exists.
    return coachName;
  }

  private async estimateMidSeriesAdaptation(teamName: string): Promise<number> {
    const rows = await db
      .select({
        date: schema.proMatches.date,
        gameNumber: schema.proMatches.gameNumber,
        blueTeam: schema.proMatches.blueTeam,
        redTeam: schema.proMatches.redTeam,
        winner: schema.proMatches.winner,
      })
      .from(schema.proMatches)
      .where(
        and(
          or(
            eq(schema.proMatches.blueTeam, teamName),
            eq(schema.proMatches.redTeam, teamName),
          ),
          gte(schema.proMatches.gameNumber, 1),
        ),
      )
      .orderBy(desc(schema.proMatches.date))
      .limit(500);

    const seriesMap = new Map<string, { first: boolean | null; second: boolean | null }>();
    for (const row of rows) {
      const dateKey = row.date ? new Date(row.date).toISOString().slice(0, 10) : "unknown";
      const teamKey = [row.blueTeam, row.redTeam].sort().join("-");
      const key = `${dateKey}:${teamKey}`;
      const existing = seriesMap.get(key) ?? { first: null, second: null };
      if ((row.gameNumber ?? 1) === 1) {
        existing.first = row.winner === teamName;
      } else if ((row.gameNumber ?? 1) === 2) {
        existing.second = row.winner === teamName;
      }
      seriesMap.set(key, existing);
    }

    let improvements = 0;
    let samples = 0;
    for (const value of seriesMap.values()) {
      if (value.first === false && value.second !== null) {
        samples += 1;
        if (value.second === true) {
          improvements += 1;
        }
      }
    }

    if (samples === 0) {
      return 0.5;
    }
    return clamp(improvements / samples, 0.2, 0.85);
  }

  private async estimatePatchAdaptation(teamName: string): Promise<number> {
    const rows = await db
      .select({
        patch: schema.proMatches.patch,
        winner: schema.proMatches.winner,
        date: schema.proMatches.date,
        blueTeam: schema.proMatches.blueTeam,
        redTeam: schema.proMatches.redTeam,
      })
      .from(schema.proMatches)
      .where(
        or(
          eq(schema.proMatches.blueTeam, teamName),
          eq(schema.proMatches.redTeam, teamName),
        ),
      )
      .orderBy(desc(schema.proMatches.date))
      .limit(500);

    const byPatch = new Map<string, boolean[]>();
    for (const row of rows) {
      const patch = row.patch ?? "unknown";
      const list = byPatch.get(patch) ?? [];
      list.push(row.winner === teamName);
      byPatch.set(patch, list);
    }

    const patchScores: number[] = [];
    for (const values of byPatch.values()) {
      if (values.length < 6) {
        continue;
      }
      const firstThree = values.slice(0, 3);
      const lastThree = values.slice(-3);
      const firstWr = firstThree.filter(Boolean).length / firstThree.length;
      const lastWr = lastThree.filter(Boolean).length / lastThree.length;
      patchScores.push(clamp(0.5 + (firstWr - lastWr) * -0.5, 0, 1));
    }

    if (patchScores.length === 0) {
      return 0.5;
    }

    return clamp(
      patchScores.reduce((sum, value) => sum + value, 0) / patchScores.length,
      0.2,
      0.85,
    );
  }

  private isCheeseChampion(champion: string): boolean {
    const cheese = new Set([
      "Heimerdinger",
      "Singed",
      "Teemo",
      "Shaco",
      "Zilean",
      "Sion",
      "Yasuo",
      "Nilah",
      "Karthus",
      "Bard",
    ]);
    return cheese.has(champion);
  }

  private topKeys(counter: Map<string, number>, limit: number): string[] {
    return [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key]) => key);
  }
}

function parseBool(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value > 0;
  }
  return String(value).toLowerCase() === "true";
}

export const coachAnalyzer = new CoachAnalyzer();
