import { and, desc, eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export interface ProBuildPath {
  buildPath: number[];
  games: number;
  wins: number;
  winRate: number;
  leagues: string[];
  patches: string[];
}

export interface ProBuildReference {
  champion: string;
  role: string;
  games: number;
  winRate: number;
  buildPath: number[];
  leagues: string[];
  patches: string[];
}

export interface ProMatchupTip {
  games: number;
  winRate: number;
  avgGoldDiffAt10: number;
  avgCspm: number;
  summary: string;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toProPosition(role: string): string {
  const normalized = role.trim().toUpperCase();

  if (normalized === "JUNGLE") {
    return "JNG";
  }

  if (normalized === "MIDDLE") {
    return "MID";
  }

  if (normalized === "ADC" || normalized === "BOTTOM") {
    return "BOT";
  }

  if (normalized === "UTILITY" || normalized === "SUPPORT") {
    return "SUP";
  }

  if (normalized === "TOP") {
    return "TOP";
  }

  if (normalized === "JNG" || normalized === "MID" || normalized === "BOT" || normalized === "SUP") {
    return normalized;
  }

  return normalized;
}

export async function getProBuildsForChampion(params: {
  champion: string;
  role: string;
  league?: string;
  patch?: string;
  recentGames?: number;
}): Promise<ProBuildPath[]> {
  if (!process.env.DATABASE_URL) {
    return [];
  }

  const recentGames = Math.max(20, Math.min(1000, params.recentGames ?? 300));
  const position = toProPosition(params.role);

  const filters = [
    eq(schema.proPlayerStats.champion, params.champion),
    eq(schema.proPlayerStats.position, position),
  ];

  if (params.league) {
    filters.push(eq(schema.proMatches.league, params.league));
  }

  if (params.patch) {
    filters.push(eq(schema.proMatches.patch, params.patch));
  }

  const rows = await db
    .select({
      items: schema.proPlayerStats.items,
      result: schema.proPlayerStats.result,
      league: schema.proMatches.league,
      patch: schema.proMatches.patch,
    })
    .from(schema.proPlayerStats)
    .innerJoin(schema.proMatches, eq(schema.proPlayerStats.gameId, schema.proMatches.gameId))
    .where(and(...filters))
    .orderBy(desc(schema.proMatches.date))
    .limit(recentGames);

  type BuildAggregate = {
    key: string;
    buildPath: number[];
    games: number;
    wins: number;
    leagues: Set<string>;
    patches: Set<string>;
  };

  const byPath = new Map<string, BuildAggregate>();

  for (const row of rows) {
    const buildPath = Array.isArray(row.items)
      ? row.items
          .slice(0, 6)
          .map((item) => Number(item))
          .filter((item): item is number => Number.isFinite(item) && item > 0)
      : [];

    if (buildPath.length === 0) {
      continue;
    }

    const key = JSON.stringify(buildPath);
    const existing = byPath.get(key) ?? {
      key,
      buildPath,
      games: 0,
      wins: 0,
      leagues: new Set<string>(),
      patches: new Set<string>(),
    };

    existing.games += 1;
    existing.wins += row.result ? 1 : 0;

    if (row.league) {
      existing.leagues.add(row.league);
    }

    if (row.patch) {
      existing.patches.add(row.patch);
    }

    byPath.set(key, existing);
  }

  return Array.from(byPath.values())
    .map((entry) => ({
      buildPath: entry.buildPath,
      games: entry.games,
      wins: entry.wins,
      winRate: entry.games > 0 ? entry.wins / entry.games : 0,
      leagues: Array.from(entry.leagues),
      patches: Array.from(entry.patches),
    }))
    .sort((a, b) => {
      if (b.games !== a.games) {
        return b.games - a.games;
      }
      return b.winRate - a.winRate;
    });
}

export async function getTopProBuildForChampion(params: {
  champion: string;
  role: string;
  league?: string;
  patch?: string;
  recentGames?: number;
}): Promise<ProBuildReference | null> {
  const builds = await getProBuildsForChampion(params);
  const top = builds[0];

  if (!top) {
    return null;
  }

  return {
    champion: params.champion,
    role: toProPosition(params.role),
    games: top.games,
    winRate: top.winRate,
    buildPath: top.buildPath,
    leagues: top.leagues,
    patches: top.patches,
  };
}

function matchupSummary(params: {
  ourChampion: string;
  enemyChampion: string;
  role: string;
  games: number;
  winRate: number;
  avgGoldDiffAt10: number;
}): string {
  const winPct = Math.round(params.winRate * 100);
  const goldDiff = Math.round(params.avgGoldDiffAt10);
  const goldLabel = `${goldDiff >= 0 ? "+" : ""}${goldDiff}g@10`;

  if (params.winRate >= 0.55 && params.avgGoldDiffAt10 >= 0) {
    return `In pro play (${params.games} games), ${params.ourChampion} into ${params.enemyChampion} (${params.role}) is played as lane-pressure into objective setup (${winPct}% WR, ${goldLabel}).`;
  }

  if (params.winRate <= 0.45 || params.avgGoldDiffAt10 < 0) {
    return `In pro play (${params.games} games), ${params.ourChampion} into ${params.enemyChampion} (${params.role}) is usually played to absorb early pressure and scale (${winPct}% WR, ${goldLabel}).`;
  }

  return `In pro play (${params.games} games), ${params.ourChampion} into ${params.enemyChampion} (${params.role}) is a tempo matchup around wave control and first reset (${winPct}% WR, ${goldLabel}).`;
}

export async function getProMatchupTip(params: {
  ourChampion: string;
  enemyChampion: string;
  role: string;
}): Promise<ProMatchupTip | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const role = toProPosition(params.role);

  const query = sql`
    select
      count(*)::int as games,
      avg(case when p1.result then 1 else 0 end)::float as win_rate,
      avg(coalesce(p1.gold_diff_at_10, 0))::float as avg_gold_diff_at_10,
      avg(coalesce(p1.cspm, 0))::float as avg_cspm
    from pro_player_stats p1
    join pro_player_stats p2
      on p1.game_id = p2.game_id
      and p1.position = p2.position
      and p1.team_name <> p2.team_name
    where p1.champion = ${params.ourChampion}
      and p2.champion = ${params.enemyChampion}
      and p1.position = ${role}
  `;

  const result = await db.execute(query);
  const row = result.rows[0] as {
    games?: number | string;
    win_rate?: number | string;
    avg_gold_diff_at_10?: number | string;
    avg_cspm?: number | string;
  } | undefined;

  const games = toNumber(row?.games);
  if (games < 5) {
    return null;
  }

  const winRate = toNumber(row?.win_rate);
  const avgGoldDiffAt10 = toNumber(row?.avg_gold_diff_at_10);
  const avgCspm = toNumber(row?.avg_cspm);

  return {
    games,
    winRate,
    avgGoldDiffAt10,
    avgCspm,
    summary: matchupSummary({
      ourChampion: params.ourChampion,
      enemyChampion: params.enemyChampion,
      role,
      games,
      winRate,
      avgGoldDiffAt10,
    }),
  };
}