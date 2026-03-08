import {
  and,
  desc,
  eq,
  or,
} from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { MatchPrediction, TeamStrengthProfile } from "@/lib/types/pro";

type TeamSnapshot = {
  teamName: string;
  gamesPlayed: number;
  winRate: number;
  firstBloodRate: number;
  avgGameDuration: number;
  blueWinRate: number;
  redWinRate: number;
};

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function getLatestTeamSnapshot(teamName: string, league: string): Promise<TeamSnapshot | null> {
  const rows = await db
    .select()
    .from(schema.proTeamStats)
    .where(and(eq(schema.proTeamStats.teamName, teamName), eq(schema.proTeamStats.league, league)))
    .orderBy(desc(schema.proTeamStats.computedAt))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    teamName: row.teamName,
    gamesPlayed: row.gamesPlayed ?? 0,
    winRate: toNumber(row.winRate),
    firstBloodRate: toNumber(row.firstBloodRate),
    avgGameDuration: toNumber(row.avgGameDuration),
    blueWinRate: toNumber(row.blueWinRate),
    redWinRate: toNumber(row.redWinRate),
  };
}

async function getRecentForm(teamName: string, league: string, games = 10): Promise<number> {
  const matches = await db
    .select({
      winner: schema.proMatches.winner,
    })
    .from(schema.proMatches)
    .where(
      and(
        eq(schema.proMatches.league, league),
        or(eq(schema.proMatches.blueTeam, teamName), eq(schema.proMatches.redTeam, teamName)),
      ),
    )
    .orderBy(desc(schema.proMatches.date))
    .limit(games);

  if (matches.length === 0) {
    return 0.5;
  }

  const wins = matches.filter((match) => match.winner === teamName).length;
  return wins / matches.length;
}

async function getHeadToHead(team1: string, team2: string, league: string, games = 20): Promise<number> {
  const rows = await db
    .select({
      winner: schema.proMatches.winner,
    })
    .from(schema.proMatches)
    .where(
      and(
        eq(schema.proMatches.league, league),
        or(
          and(eq(schema.proMatches.blueTeam, team1), eq(schema.proMatches.redTeam, team2)),
          and(eq(schema.proMatches.blueTeam, team2), eq(schema.proMatches.redTeam, team1)),
        ),
      ),
    )
    .orderBy(desc(schema.proMatches.date))
    .limit(games);

  if (rows.length === 0) {
    return 0.5;
  }

  const team1Wins = rows.filter((row) => row.winner === team1).length;
  return team1Wins / rows.length;
}

export class ProMatchPredictor {
  async predictMatch(team1: string, team2: string, league: string): Promise<MatchPrediction> {
    const [team1Stats, team2Stats, team1Recent, team2Recent, headToHead] = await Promise.all([
      getLatestTeamSnapshot(team1, league),
      getLatestTeamSnapshot(team2, league),
      getRecentForm(team1, league, 10),
      getRecentForm(team2, league, 10),
      getHeadToHead(team1, team2, league, 20),
    ]);

    const t1 = team1Stats ?? {
      teamName: team1,
      gamesPlayed: 0,
      winRate: 0.5,
      firstBloodRate: 0.5,
      avgGameDuration: 2000,
      blueWinRate: 0.5,
      redWinRate: 0.5,
    };
    const t2 = team2Stats ?? {
      teamName: team2,
      gamesPlayed: 0,
      winRate: 0.5,
      firstBloodRate: 0.5,
      avgGameDuration: 2000,
      blueWinRate: 0.5,
      redWinRate: 0.5,
    };

    const winRateDiff = t1.winRate - t2.winRate;
    const recentFormDiff = team1Recent - team2Recent;
    const headToHeadDiff = headToHead - 0.5;
    const firstBloodDiff = t1.firstBloodRate - t2.firstBloodRate;
    const durationDiff = (t2.avgGameDuration - t1.avgGameDuration) / 2400;
    const sideAdvantageDiff = ((t1.blueWinRate + t1.redWinRate) / 2) - ((t2.blueWinRate + t2.redWinRate) / 2);

    const score =
      winRateDiff * 2.1 +
      recentFormDiff * 4.0 +
      headToHeadDiff * 3.0 +
      firstBloodDiff * 1.8 +
      durationDiff * 0.8 +
      sideAdvantageDiff * 1.2;

    const team1WinProb = clamp(sigmoid(score), 0.05, 0.95);
    const team2WinProb = 1 - team1WinProb;

    const keyFactors = [
      {
        factor: `${team1} overall win rate ${Math.round(t1.winRate * 100)}% vs ${team2} ${Math.round(t2.winRate * 100)}%`,
        favoredTeam: winRateDiff >= 0 ? team1 : team2,
        impact: Math.abs(winRateDiff * 2.1),
      },
      {
        factor: `Recent form (last 10): ${team1} ${Math.round(team1Recent * 100)}% vs ${team2} ${Math.round(team2Recent * 100)}%`,
        favoredTeam: recentFormDiff >= 0 ? team1 : team2,
        impact: Math.abs(recentFormDiff * 4.0),
      },
      {
        factor: `Head-to-head edge: ${team1} ${Math.round(headToHead * 100)}%`,
        favoredTeam: headToHead >= 0.5 ? team1 : team2,
        impact: Math.abs(headToHeadDiff * 3.0),
      },
      {
        factor: `First blood rate: ${team1} ${Math.round(t1.firstBloodRate * 100)}% vs ${team2} ${Math.round(t2.firstBloodRate * 100)}%`,
        favoredTeam: firstBloodDiff >= 0 ? team1 : team2,
        impact: Math.abs(firstBloodDiff * 1.8),
      },
    ]
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 4);

    const sampleSize = Math.min(t1.gamesPlayed, t2.gamesPlayed);
    const confidence: MatchPrediction["confidence"] =
      sampleSize >= 30 ? "high" : sampleSize >= 12 ? "medium" : "low";

    return {
      team1,
      team2,
      team1WinProb,
      team2WinProb,
      confidence,
      keyFactors,
    };
  }

  async getTeamStrengthProfile(teamName: string, split: string): Promise<TeamStrengthProfile> {
    const rows = await db
      .select()
      .from(schema.proTeamStats)
      .where(and(eq(schema.proTeamStats.teamName, teamName), eq(schema.proTeamStats.split, split)))
      .orderBy(desc(schema.proTeamStats.computedAt))
      .limit(1);

    const stats = rows[0];
    if (!stats) {
      return {
        earlyGame: 50,
        objectiveControl: 50,
        teamfighting: 50,
        closingSpeed: 50,
        consistency: 50,
      };
    }

    const recentMatches = await db
      .select({ winner: schema.proMatches.winner })
      .from(schema.proMatches)
      .where(
        and(
          eq(schema.proMatches.split, split),
          or(eq(schema.proMatches.blueTeam, teamName), eq(schema.proMatches.redTeam, teamName)),
        ),
      )
      .orderBy(desc(schema.proMatches.date))
      .limit(10);

    const winSeries: number[] = recentMatches.map((match) =>
      match.winner === teamName ? 1 : 0,
    );
    const mean = winSeries.length > 0 ? winSeries.reduce((acc, v) => acc + v, 0) / winSeries.length : 0.5;
    const variance =
      winSeries.length > 0
        ? winSeries.reduce((acc, v) => acc + (v - mean) ** 2, 0) / winSeries.length
        : 0.25;

    const earlyGame = clamp(
      ((toNumber(stats.firstBloodRate) + toNumber(stats.firstDragonRate)) / 2) * 100,
      0,
      100,
    );
    const objectiveControl = clamp(
      ((toNumber(stats.firstDragonRate) + toNumber(stats.firstBaronRate) + toNumber(stats.firstTowerRate)) / 3) * 100,
      0,
      100,
    );
    const teamfighting = clamp(
      ((toNumber(stats.avgKillsPerGame) / Math.max(1, toNumber(stats.avgDeathsPerGame) + 1)) * 35) +
        toNumber(stats.winRate) * 45,
      0,
      100,
    );
    const closingSpeed = clamp(
      (1 - toNumber(stats.avgGameDuration) / 2600) * 100,
      0,
      100,
    );
    const consistency = clamp((1 - variance) * 100, 0, 100);

    return {
      earlyGame,
      objectiveControl,
      teamfighting,
      closingSpeed,
      consistency,
    };
  }
}
