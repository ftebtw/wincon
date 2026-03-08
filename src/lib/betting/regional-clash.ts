import { and, desc, eq, inArray, or } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export interface RegionalStyle {
  region: string;
  avgGameDuration: number;
  avgGoldDiffAt15: number;
  firstBloodRate: number;
  dragonPriority: number;
  baronCallRate: number;
  teamfightFrequency: number;
  visionControl: number;
  laneSwapRate: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRegion(region: string): string {
  const upper = region.toUpperCase();
  if (upper.includes("LCK") || upper === "KR") return "KR";
  if (upper.includes("LPL") || upper === "CN") return "CN";
  if (upper.includes("LEC") || upper === "EU") return "EU";
  if (upper.includes("LCS") || upper === "NA") return "NA";
  return upper;
}

function isInternationalEvent(event: string): boolean {
  const normalized = event.toLowerCase();
  return (
    normalized.includes("world") ||
    normalized.includes("msi") ||
    normalized.includes("rift rivals") ||
    normalized.includes("international")
  );
}

export class RegionalClashModel {
  async getRegionalClashAdjustment(
    team1: string,
    team1Region: string,
    team2: string,
    team2Region: string,
    event: string,
    patchAge: number,
    hostRegion?: string,
  ): Promise<{
    team1Adjustment: number;
    team2Adjustment: number;
    reasoning: string;
  }> {
    if (!isInternationalEvent(event)) {
      return {
        team1Adjustment: 0,
        team2Adjustment: 0,
        reasoning: "Domestic event; regional clash model disabled.",
      };
    }

    const [style1, style2, historical] = await Promise.all([
      this.getRegionalStyle(normalizeRegion(team1Region)),
      this.getRegionalStyle(normalizeRegion(team2Region)),
      this.getInterRegionalHeadToHead(
        normalizeRegion(team1Region),
        normalizeRegion(team2Region),
      ),
    ]);

    let adjustment = 0;

    // Style-to-style edge: faster early regions do better early patch.
    const styleTempoEdge =
      (style1.firstBloodRate - style2.firstBloodRate) * 0.04 +
      (style1.teamfightFrequency - style2.teamfightFrequency) * 0.03;
    adjustment += styleTempoEdge * (patchAge <= 7 ? 1 : 0.55);

    // Historical inter-regional matchup base.
    adjustment += (historical - 0.5) * 0.05;

    // Late patch favors structured macro and vision-heavy regions.
    if (patchAge >= 10) {
      adjustment += (style1.visionControl - style2.visionControl) * 0.03;
    }

    // Small home crowd modifier if host region is known.
    if (hostRegion) {
      const normalizedHost = normalizeRegion(hostRegion);
      if (normalizedHost === normalizeRegion(team1Region)) {
        adjustment += 0.02;
      } else if (normalizedHost === normalizeRegion(team2Region)) {
        adjustment -= 0.02;
      }
    }

    // LCS international historical drag.
    if (normalizeRegion(team1Region) === "NA") {
      adjustment -= 0.015;
    }
    if (normalizeRegion(team2Region) === "NA") {
      adjustment += 0.015;
    }

    adjustment = clamp(adjustment, -0.08, 0.08);

    return {
      team1Adjustment: adjustment,
      team2Adjustment: -adjustment,
      reasoning:
        `Regional style clash ${normalizeRegion(team1Region)} vs ${normalizeRegion(team2Region)}; ` +
        `patch-age weighted adjustment applied.`,
    };
  }

  private async getRegionalStyle(region: string): Promise<RegionalStyle> {
    const teams = await db
      .select({ teamName: schema.proTeams.teamName, region: schema.proTeams.region })
      .from(schema.proTeams)
      .where(eq(schema.proTeams.region, region))
      .limit(40);

    const teamNames = teams.map((entry) => entry.teamName);
    if (teamNames.length === 0) {
      return this.fallbackRegionalStyle(region);
    }

    const [teamStats, playerStats] = await Promise.all([
      db
        .select({
          avgGameDuration: schema.proTeamStats.avgGameDuration,
          firstBloodRate: schema.proTeamStats.firstBloodRate,
          firstDragonRate: schema.proTeamStats.firstDragonRate,
          firstBaronRate: schema.proTeamStats.firstBaronRate,
        })
        .from(schema.proTeamStats)
        .where(inArray(schema.proTeamStats.teamName, teamNames))
        .orderBy(desc(schema.proTeamStats.computedAt))
        .limit(300),
      db
        .select({
          kills: schema.proPlayerStats.kills,
          deaths: schema.proPlayerStats.deaths,
          visionScore: schema.proPlayerStats.visionScore,
          goldDiffAt15: schema.proPlayerStats.goldDiffAt15,
        })
        .from(schema.proPlayerStats)
        .where(inArray(schema.proPlayerStats.teamName, teamNames))
        .limit(5000),
    ]);

    if (teamStats.length === 0 && playerStats.length === 0) {
      return this.fallbackRegionalStyle(region);
    }

    const avgGameDuration =
      teamStats.length > 0
        ? teamStats.reduce((sum, row) => sum + Number(row.avgGameDuration ?? 1900), 0) /
          teamStats.length
        : 1900;
    const firstBloodRate =
      teamStats.length > 0
        ? teamStats.reduce((sum, row) => sum + Number(row.firstBloodRate ?? 0.5), 0) /
          teamStats.length
        : 0.5;
    const dragonPriority =
      teamStats.length > 0
        ? teamStats.reduce((sum, row) => sum + Number(row.firstDragonRate ?? 0.5), 0) /
          teamStats.length
        : 0.5;
    const baronCallRate =
      teamStats.length > 0
        ? teamStats.reduce((sum, row) => sum + Number(row.firstBaronRate ?? 0.5), 0) /
          teamStats.length
        : 0.5;

    const teamfightFrequency =
      playerStats.length > 0
        ? clamp(
            playerStats.reduce(
              (sum, row) => sum + Number(row.kills ?? 0) + Number(row.deaths ?? 0),
              0,
            ) /
              playerStats.length /
              6,
            0,
            1,
          )
        : 0.5;
    const visionControl =
      playerStats.length > 0
        ? clamp(
            playerStats.reduce((sum, row) => sum + Number(row.visionScore ?? 0), 0) /
              playerStats.length /
              25,
            0,
            1,
          )
        : 0.5;

    return {
      region,
      avgGameDuration,
      avgGoldDiffAt15:
        playerStats.length > 0
          ? playerStats.reduce((sum, row) => sum + Number(row.goldDiffAt15 ?? 0), 0) /
            playerStats.length
          : 0,
      firstBloodRate: clamp(firstBloodRate, 0, 1),
      dragonPriority: clamp(dragonPriority, 0, 1),
      baronCallRate: clamp(baronCallRate, 0, 1),
      teamfightFrequency,
      visionControl,
      laneSwapRate: region === "CN" ? 0.2 : region === "KR" ? 0.14 : 0.11,
    };
  }

  private async getInterRegionalHeadToHead(region1: string, region2: string): Promise<number> {
    const teamRows = await db
      .select({
        teamName: schema.proTeams.teamName,
        region: schema.proTeams.region,
      })
      .from(schema.proTeams)
      .where(inArray(schema.proTeams.region, [region1, region2]))
      .limit(200);

    const region1Teams = teamRows
      .filter((entry) => normalizeRegion(entry.region) === region1)
      .map((entry) => entry.teamName);
    const region2Teams = teamRows
      .filter((entry) => normalizeRegion(entry.region) === region2)
      .map((entry) => entry.teamName);

    if (region1Teams.length === 0 || region2Teams.length === 0) {
      return 0.5;
    }

    const matches = await db
      .select({
        blueTeam: schema.proMatches.blueTeam,
        redTeam: schema.proMatches.redTeam,
        winner: schema.proMatches.winner,
        league: schema.proMatches.league,
      })
      .from(schema.proMatches)
      .where(
        and(
          or(
            inArray(schema.proMatches.blueTeam, region1Teams),
            inArray(schema.proMatches.redTeam, region1Teams),
          ),
          or(
            inArray(schema.proMatches.blueTeam, region2Teams),
            inArray(schema.proMatches.redTeam, region2Teams),
          ),
        ),
      )
      .orderBy(desc(schema.proMatches.date))
      .limit(300);

    const international = matches.filter((row) =>
      isInternationalEvent(row.league ?? ""),
    );
    const sample = international.length > 0 ? international : matches;
    if (sample.length === 0) {
      return 0.5;
    }

    const region1Wins = sample.filter((row) => region1Teams.includes(row.winner)).length;
    return clamp(region1Wins / sample.length, 0.2, 0.8);
  }

  private fallbackRegionalStyle(region: string): RegionalStyle {
    const map: Record<string, RegionalStyle> = {
      KR: {
        region,
        avgGameDuration: 2050,
        avgGoldDiffAt15: 180,
        firstBloodRate: 0.5,
        dragonPriority: 0.56,
        baronCallRate: 0.54,
        teamfightFrequency: 0.52,
        visionControl: 0.72,
        laneSwapRate: 0.14,
      },
      CN: {
        region,
        avgGameDuration: 1970,
        avgGoldDiffAt15: 250,
        firstBloodRate: 0.56,
        dragonPriority: 0.53,
        baronCallRate: 0.49,
        teamfightFrequency: 0.67,
        visionControl: 0.58,
        laneSwapRate: 0.2,
      },
      EU: {
        region,
        avgGameDuration: 2020,
        avgGoldDiffAt15: 140,
        firstBloodRate: 0.51,
        dragonPriority: 0.51,
        baronCallRate: 0.5,
        teamfightFrequency: 0.55,
        visionControl: 0.61,
        laneSwapRate: 0.1,
      },
      NA: {
        region,
        avgGameDuration: 2060,
        avgGoldDiffAt15: 100,
        firstBloodRate: 0.48,
        dragonPriority: 0.49,
        baronCallRate: 0.47,
        teamfightFrequency: 0.5,
        visionControl: 0.6,
        laneSwapRate: 0.09,
      },
    };

    return map[region] ?? map.EU;
  }
}

export const regionalClashModel = new RegionalClashModel();

