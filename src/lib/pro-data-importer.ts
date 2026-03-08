import {
  and,
  desc,
  eq,
  ne,
  sql,
} from "drizzle-orm";
import Papa from "papaparse";

import { db, schema } from "@/lib/db";
import type { ImportReport, ProBuild, ProPlayerAverages } from "@/lib/types/pro";

type OracleCsvRow = Record<string, string>;

type TeamUpsert = {
  teamName: string;
  teamSlug: string;
  league: string;
  region: string;
  split: string | null;
};

type MatchAccumulator = {
  gameId: string;
  league: string;
  split: string | null;
  playoffs: boolean;
  date: Date | null;
  gameNumber: number | null;
  patch: string | null;
  gameDuration: number | null;
  blueTeam: string | null;
  redTeam: string | null;
  winner: string | null;
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(normalized)) {
    return false;
  }

  return null;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function parseDecimal(value: string | undefined, scale = 4): string | null {
  const parsed = parseNumber(value);
  if (parsed === null) {
    return null;
  }

  return parsed.toFixed(scale);
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function normalizePosition(value: string | undefined): string {
  const normalized = (value ?? "").trim().toUpperCase();
  if (["TOP", "JNG", "JUNGLE", "MID", "BOT", "ADC", "SUP", "SUPPORT", "TEAM"].includes(normalized)) {
    if (normalized === "JNG" || normalized === "JUNGLE") {
      return "JNG";
    }
    if (normalized === "SUPPORT") {
      return "SUP";
    }
    if (normalized === "ADC") {
      return "BOT";
    }
    return normalized;
  }

  return normalized || "UNKNOWN";
}

function normalizeSide(value: string | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "blue" || normalized === "b") {
    return "BLUE";
  }
  if (normalized === "red" || normalized === "r") {
    return "RED";
  }

  return null;
}

function parseItems(row: OracleCsvRow): Array<number | string> {
  const itemFields = Object.keys(row)
    .filter((key) => key.startsWith("item"))
    .sort((a, b) => a.localeCompare(b));

  const items: Array<number | string> = [];
  for (const field of itemFields) {
    const value = row[field]?.trim();
    if (!value) {
      continue;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      items.push(numeric);
    } else {
      items.push(value);
    }
  }

  return items;
}

function parsePatch(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const parts = value.split(".");
  if (parts.length < 2) {
    return value;
  }

  return `${parts[0]}.${parts[1]}`;
}

function slugifyTeam(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferRegionFromLeague(league: string): string {
  const normalized = league.toUpperCase();
  if (normalized.startsWith("LCK")) {
    return "Korea";
  }
  if (normalized.startsWith("LPL")) {
    return "China";
  }
  if (normalized.startsWith("LEC") || normalized.startsWith("EMEA")) {
    return "Europe";
  }
  if (normalized.startsWith("LCS") || normalized.startsWith("NACL")) {
    return "North America";
  }
  if (normalized.startsWith("LJL")) {
    return "Japan";
  }
  if (normalized.startsWith("PCS") || normalized.startsWith("VCS")) {
    return "Pacific";
  }

  return "Other";
}

function rowValue(row: OracleCsvRow, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const normalized = normalizeHeader(key);
    if (row[normalized] !== undefined) {
      return row[normalized];
    }
  }

  return undefined;
}

export class ProDataImporter {
  async downloadCSV(year: number): Promise<string> {
    const url = `https://oracleselixir-downloadable-match-data.s3-us-west-2.amazonaws.com/${year}_LoL_esports_match_data_from_OraclesElixir.csv`;
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Failed to download Oracle's Elixir CSV (${response.status}).`);
    }

    return response.text();
  }

  async parseAndImport(csvText: string): Promise<ImportReport> {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for Oracle import.");
    }

    const parsed = Papa.parse<OracleCsvRow>(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: normalizeHeader,
    });

    const report: ImportReport = {
      teamsImported: 0,
      playersImported: 0,
      matchesImported: 0,
      playerStatsImported: 0,
      errors: [],
    };

    if (parsed.errors.length > 0) {
      for (const error of parsed.errors.slice(0, 50)) {
        report.errors.push(error.message);
      }
    }

    const teamMap = new Map<string, TeamUpsert>();
    const playerMap = new Map<string, { playerName: string; teamName: string; position: string; league: string }>();
    const matchMap = new Map<string, MatchAccumulator>();
    const playerStats: Array<typeof schema.proPlayerStats.$inferInsert> = [];

    for (const row of parsed.data) {
      const gameId = rowValue(row, "gameid");
      const league = rowValue(row, "league");
      const teamName = rowValue(row, "teamname");
      const playerName = rowValue(row, "playername");
      const position = normalizePosition(rowValue(row, "position"));

      if (!gameId || !league || !teamName) {
        continue;
      }

      const split = rowValue(row, "split") ?? null;
      const teamSlug = slugifyTeam(teamName);
      teamMap.set(teamName, {
        teamName,
        teamSlug,
        league,
        region: inferRegionFromLeague(league),
        split,
      });

      const match = matchMap.get(gameId) ?? {
        gameId,
        league,
        split,
        playoffs: parseBoolean(rowValue(row, "playoffs")) ?? false,
        date: parseDate(rowValue(row, "date")),
        gameNumber: parseNumber(rowValue(row, "game")) ?? null,
        patch: parsePatch(rowValue(row, "patch")),
        gameDuration: parseNumber(rowValue(row, "gamelength")) ?? null,
        blueTeam: null,
        redTeam: null,
        winner: null,
      };

      const side = normalizeSide(rowValue(row, "side"));
      const result = parseBoolean(rowValue(row, "result")) ?? false;
      if (side === "BLUE") {
        match.blueTeam = teamName;
      } else if (side === "RED") {
        match.redTeam = teamName;
      }
      if (result) {
        match.winner = teamName;
      }
      matchMap.set(gameId, match);

      if (position !== "TEAM" && playerName) {
        playerMap.set(`${playerName}:${teamName}:${position}`, {
          playerName,
          teamName,
          position,
          league,
        });
      }

      const statsRow: typeof schema.proPlayerStats.$inferInsert = {
        gameId,
        playerName: playerName ?? teamName,
        teamName,
        champion: rowValue(row, "champion") ?? (position === "TEAM" ? "TEAM" : "UNKNOWN"),
        position,
        result,
        kills: parseNumber(rowValue(row, "kills")),
        deaths: parseNumber(rowValue(row, "deaths")),
        assists: parseNumber(rowValue(row, "assists")),
        cs: parseNumber(rowValue(row, "total cs", "cs")),
        cspm: parseDecimal(rowValue(row, "cspm"), 1),
        dpm: parseDecimal(rowValue(row, "dpm"), 1),
        goldShare: parseDecimal(rowValue(row, "earnedgoldshare"), 4),
        damageShare: parseDecimal(rowValue(row, "damageshare"), 4),
        visionScore: parseDecimal(rowValue(row, "vspm"), 1),
        goldAt10: parseNumber(rowValue(row, "goldat10")),
        goldAt15: parseNumber(rowValue(row, "goldat15")),
        goldDiffAt10: parseNumber(rowValue(row, "golddiffat10")),
        goldDiffAt15: parseNumber(rowValue(row, "golddiffat15")),
        csAt10: parseNumber(rowValue(row, "csat10")),
        csAt15: parseNumber(rowValue(row, "csat15")),
        xpAt10: parseNumber(rowValue(row, "xpat10")),
        firstBlood: parseBoolean(rowValue(row, "firstblood")),
        firstDragon: parseBoolean(rowValue(row, "firstdragon")),
        firstBaron: parseBoolean(rowValue(row, "firstbaron")),
        firstTower: parseBoolean(rowValue(row, "firsttower")),
        dragons: parseNumber(rowValue(row, "dragons")),
        barons: parseNumber(rowValue(row, "barons")),
        towers: parseNumber(rowValue(row, "towers")),
        side,
        items: parseItems(row),
      };
      playerStats.push(statsRow);
    }

    try {
      await db.transaction(async (tx) => {
        if (teamMap.size > 0) {
          for (const team of teamMap.values()) {
            await tx
              .insert(schema.proTeams)
              .values({
                teamName: team.teamName,
                teamSlug: team.teamSlug,
                league: team.league,
                region: team.region,
                split: team.split,
                lastUpdated: new Date(),
              })
              .onConflictDoUpdate({
                target: schema.proTeams.teamSlug,
                set: {
                  teamName: team.teamName,
                  league: team.league,
                  region: team.region,
                  split: team.split,
                  lastUpdated: new Date(),
                },
              });
          }
          report.teamsImported = teamMap.size;
        }

        const teamRows = await tx
          .select({
            id: schema.proTeams.id,
            teamName: schema.proTeams.teamName,
          })
          .from(schema.proTeams);
        const teamIdByName = new Map(teamRows.map((row) => [row.teamName, row.id]));

        if (playerMap.size > 0) {
          for (const player of playerMap.values()) {
            await tx
              .insert(schema.proPlayers)
              .values({
                playerName: player.playerName,
                teamId: teamIdByName.get(player.teamName) ?? null,
                position: player.position,
                league: player.league,
                lastUpdated: new Date(),
              })
              .onConflictDoNothing();
          }
          report.playersImported = playerMap.size;
        }

        if (matchMap.size > 0) {
          for (const match of matchMap.values()) {
            await tx
              .insert(schema.proMatches)
              .values({
                gameId: match.gameId,
                league: match.league,
                split: match.split,
                playoffs: match.playoffs,
                date: match.date,
                gameNumber: match.gameNumber,
                blueTeam: match.blueTeam ?? "Unknown",
                redTeam: match.redTeam ?? "Unknown",
                winner: match.winner ?? "Unknown",
                gameDuration: match.gameDuration,
                patch: match.patch,
              })
              .onConflictDoUpdate({
                target: schema.proMatches.gameId,
                set: {
                  league: match.league,
                  split: match.split,
                  playoffs: match.playoffs,
                  date: match.date,
                  gameNumber: match.gameNumber,
                  blueTeam: match.blueTeam ?? "Unknown",
                  redTeam: match.redTeam ?? "Unknown",
                  winner: match.winner ?? "Unknown",
                  gameDuration: match.gameDuration,
                  patch: match.patch,
                },
              });
          }
          report.matchesImported = matchMap.size;
        }

        if (playerStats.length > 0) {
          const chunkSize = 500;
          for (let index = 0; index < playerStats.length; index += chunkSize) {
            const chunk = playerStats.slice(index, index + chunkSize);
            await tx
              .insert(schema.proPlayerStats)
              .values(chunk)
              .onConflictDoUpdate({
                target: [
                  schema.proPlayerStats.gameId,
                  schema.proPlayerStats.playerName,
                  schema.proPlayerStats.teamName,
                  schema.proPlayerStats.position,
                ],
                set: {
                  champion: sql`excluded.champion`,
                  result: sql`excluded.result`,
                  kills: sql`excluded.kills`,
                  deaths: sql`excluded.deaths`,
                  assists: sql`excluded.assists`,
                  cs: sql`excluded.cs`,
                  cspm: sql`excluded.cspm`,
                  dpm: sql`excluded.dpm`,
                  goldShare: sql`excluded.gold_share`,
                  damageShare: sql`excluded.damage_share`,
                  visionScore: sql`excluded.vision_score`,
                  goldAt10: sql`excluded.gold_at_10`,
                  goldAt15: sql`excluded.gold_at_15`,
                  goldDiffAt10: sql`excluded.gold_diff_at_10`,
                  goldDiffAt15: sql`excluded.gold_diff_at_15`,
                  csAt10: sql`excluded.cs_at_10`,
                  csAt15: sql`excluded.cs_at_15`,
                  xpAt10: sql`excluded.xp_at_10`,
                  firstBlood: sql`excluded.first_blood`,
                  firstDragon: sql`excluded.first_dragon`,
                  firstBaron: sql`excluded.first_baron`,
                  firstTower: sql`excluded.first_tower`,
                  dragons: sql`excluded.dragons`,
                  barons: sql`excluded.barons`,
                  towers: sql`excluded.towers`,
                  side: sql`excluded.side`,
                  items: sql`excluded.items`,
                },
              });
          }
          report.playerStatsImported = playerStats.length;
        }
      });
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : "Unknown import error.");
    }

    return report;
  }

  async computeTeamStats(league?: string, split?: string): Promise<void> {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for team stats computation.");
    }

    const rows = await db
      .select({
        teamName: schema.proPlayerStats.teamName,
        result: schema.proPlayerStats.result,
        kills: schema.proPlayerStats.kills,
        deaths: schema.proPlayerStats.deaths,
        firstBlood: schema.proPlayerStats.firstBlood,
        firstDragon: schema.proPlayerStats.firstDragon,
        firstBaron: schema.proPlayerStats.firstBaron,
        firstTower: schema.proPlayerStats.firstTower,
        dragons: schema.proPlayerStats.dragons,
        towers: schema.proPlayerStats.towers,
        side: schema.proPlayerStats.side,
        league: schema.proMatches.league,
        split: schema.proMatches.split,
        gameDuration: schema.proMatches.gameDuration,
      })
      .from(schema.proPlayerStats)
      .innerJoin(schema.proMatches, eq(schema.proPlayerStats.gameId, schema.proMatches.gameId))
      .where(
        and(
          eq(schema.proPlayerStats.position, "TEAM"),
          league ? eq(schema.proMatches.league, league) : sql`true`,
          split ? eq(schema.proMatches.split, split) : sql`true`,
        ),
      );

    type Aggregate = {
      teamName: string;
      league: string;
      split: string;
      games: number;
      wins: number;
      losses: number;
      totalDuration: number;
      firstBloods: number;
      firstDragons: number;
      firstBarons: number;
      firstTowers: number;
      totalKills: number;
      totalDeaths: number;
      totalTowers: number;
      totalDragons: number;
      blueGames: number;
      blueWins: number;
      redGames: number;
      redWins: number;
    };

    const aggregates = new Map<string, Aggregate>();

    for (const row of rows) {
      const rowLeague = row.league ?? "Unknown";
      const rowSplit = row.split ?? "Unknown";
      const key = `${row.teamName}:${rowLeague}:${rowSplit}`;
      const existing = aggregates.get(key) ?? {
        teamName: row.teamName,
        league: rowLeague,
        split: rowSplit,
        games: 0,
        wins: 0,
        losses: 0,
        totalDuration: 0,
        firstBloods: 0,
        firstDragons: 0,
        firstBarons: 0,
        firstTowers: 0,
        totalKills: 0,
        totalDeaths: 0,
        totalTowers: 0,
        totalDragons: 0,
        blueGames: 0,
        blueWins: 0,
        redGames: 0,
        redWins: 0,
      };

      existing.games += 1;
      existing.wins += row.result ? 1 : 0;
      existing.losses += row.result ? 0 : 1;
      existing.totalDuration += row.gameDuration ?? 0;
      existing.firstBloods += row.firstBlood ? 1 : 0;
      existing.firstDragons += row.firstDragon ? 1 : 0;
      existing.firstBarons += row.firstBaron ? 1 : 0;
      existing.firstTowers += row.firstTower ? 1 : 0;
      existing.totalKills += row.kills ?? 0;
      existing.totalDeaths += row.deaths ?? 0;
      existing.totalTowers += row.towers ?? 0;
      existing.totalDragons += row.dragons ?? 0;

      if (row.side === "BLUE") {
        existing.blueGames += 1;
        existing.blueWins += row.result ? 1 : 0;
      } else if (row.side === "RED") {
        existing.redGames += 1;
        existing.redWins += row.result ? 1 : 0;
      }

      aggregates.set(key, existing);
    }

    for (const aggregate of aggregates.values()) {
      const games = Math.max(1, aggregate.games);
      const blueGames = Math.max(1, aggregate.blueGames);
      const redGames = Math.max(1, aggregate.redGames);

      const row: typeof schema.proTeamStats.$inferInsert = {
        teamName: aggregate.teamName,
        league: aggregate.league,
        split: aggregate.split,
        gamesPlayed: aggregate.games,
        wins: aggregate.wins,
        losses: aggregate.losses,
        winRate: (aggregate.wins / games).toFixed(4),
        avgGameDuration: (aggregate.totalDuration / games).toFixed(1),
        firstBloodRate: (aggregate.firstBloods / games).toFixed(4),
        firstDragonRate: (aggregate.firstDragons / games).toFixed(4),
        firstTowerRate: (aggregate.firstTowers / games).toFixed(4),
        firstBaronRate: (aggregate.firstBarons / games).toFixed(4),
        avgKillsPerGame: (aggregate.totalKills / games).toFixed(1),
        avgDeathsPerGame: (aggregate.totalDeaths / games).toFixed(1),
        avgTowersPerGame: (aggregate.totalTowers / games).toFixed(1),
        avgDragonsPerGame: (aggregate.totalDragons / games).toFixed(1),
        blueWinRate: (aggregate.blueWins / blueGames).toFixed(4),
        redWinRate: (aggregate.redWins / redGames).toFixed(4),
        computedAt: new Date(),
      };

      await db
        .insert(schema.proTeamStats)
        .values(row)
        .onConflictDoUpdate({
          target: [
            schema.proTeamStats.teamName,
            schema.proTeamStats.league,
            schema.proTeamStats.split,
          ],
          set: {
            gamesPlayed: row.gamesPlayed,
            wins: row.wins,
            losses: row.losses,
            winRate: row.winRate,
            avgGameDuration: row.avgGameDuration,
            firstBloodRate: row.firstBloodRate,
            firstDragonRate: row.firstDragonRate,
            firstTowerRate: row.firstTowerRate,
            firstBaronRate: row.firstBaronRate,
            avgKillsPerGame: row.avgKillsPerGame,
            avgDeathsPerGame: row.avgDeathsPerGame,
            avgTowersPerGame: row.avgTowersPerGame,
            avgDragonsPerGame: row.avgDragonsPerGame,
            blueWinRate: row.blueWinRate,
            redWinRate: row.redWinRate,
            computedAt: row.computedAt,
          },
        });

      await db
        .update(schema.proTeams)
        .set({
          league: aggregate.league,
          split: aggregate.split,
          wins: aggregate.wins,
          losses: aggregate.losses,
          winRate: (aggregate.wins / games).toFixed(4),
          lastUpdated: new Date(),
        })
        .where(eq(schema.proTeams.teamName, aggregate.teamName));
    }
  }

  async computePlayerAverages(playerName: string): Promise<ProPlayerAverages> {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for player averages.");
    }

    const rows = await db
      .select()
      .from(schema.proPlayerStats)
      .where(
        and(
          eq(schema.proPlayerStats.playerName, playerName),
          ne(schema.proPlayerStats.position, "TEAM"),
        ),
      )
      .orderBy(desc(schema.proPlayerStats.id))
      .limit(100);

    if (rows.length === 0) {
      return {
        playerName,
        games: 0,
        avgKills: 0,
        avgDeaths: 0,
        avgAssists: 0,
        avgCspm: 0,
        avgDpm: 0,
        avgGoldShare: 0,
        avgDamageShare: 0,
        avgVisionScore: 0,
        avgGoldDiffAt10: 0,
        avgCsAt10: 0,
      };
    }

    const games = rows.length;
    const sum = <T extends number | string | null>(values: T[]): number =>
      values.reduce((acc, current) => acc + Number(current ?? 0), 0);

    return {
      playerName,
      games,
      avgKills: sum(rows.map((row) => row.kills)) / games,
      avgDeaths: sum(rows.map((row) => row.deaths)) / games,
      avgAssists: sum(rows.map((row) => row.assists)) / games,
      avgCspm: sum(rows.map((row) => row.cspm)) / games,
      avgDpm: sum(rows.map((row) => row.dpm)) / games,
      avgGoldShare: sum(rows.map((row) => row.goldShare)) / games,
      avgDamageShare: sum(rows.map((row) => row.damageShare)) / games,
      avgVisionScore: sum(rows.map((row) => row.visionScore)) / games,
      avgGoldDiffAt10: sum(rows.map((row) => row.goldDiffAt10)) / games,
      avgCsAt10: sum(rows.map((row) => row.csAt10)) / games,
    };
  }

  async getChampionProBuilds(
    champion: string,
    role: string,
    recentGames = 200,
  ): Promise<ProBuild[]> {
    if (!process.env.DATABASE_URL) {
      return [];
    }

    const normalizedRole = normalizePosition(role);
    const rows = await db
      .select({
        items: schema.proPlayerStats.items,
        result: schema.proPlayerStats.result,
        league: schema.proMatches.league,
      })
      .from(schema.proPlayerStats)
      .innerJoin(schema.proMatches, eq(schema.proPlayerStats.gameId, schema.proMatches.gameId))
      .where(
        and(
          eq(schema.proPlayerStats.champion, champion),
          eq(schema.proPlayerStats.position, normalizedRole),
        ),
      )
      .orderBy(desc(schema.proMatches.date))
      .limit(recentGames);

    type Aggregate = {
      key: string;
      buildPath: Array<number | string>;
      games: number;
      wins: number;
      leagues: Set<string>;
    };

    const aggregates = new Map<string, Aggregate>();

    for (const row of rows) {
      const buildPath = Array.isArray(row.items) ? row.items.slice(0, 6) : [];
      const key = JSON.stringify(buildPath);

      const existing = aggregates.get(key) ?? {
        key,
        buildPath,
        games: 0,
        wins: 0,
        leagues: new Set<string>(),
      };

      existing.games += 1;
      existing.wins += row.result ? 1 : 0;
      if (row.league) {
        existing.leagues.add(row.league);
      }

      aggregates.set(key, existing);
    }

    return Array.from(aggregates.values())
      .map((entry) => ({
        buildPath: entry.buildPath,
        games: entry.games,
        wins: entry.wins,
        winRate: entry.games > 0 ? entry.wins / entry.games : 0,
        leagues: Array.from(entry.leagues),
      }))
      .sort((a, b) => b.games - a.games);
  }
}
