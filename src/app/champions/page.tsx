import Image from "next/image";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db, schema } from "@/lib/db";
import { getChampionByName, getChampionIconUrl } from "@/lib/data-dragon";
import { opggClient } from "@/lib/opgg-mcp";
import { patchTracker } from "@/lib/patch-tracker";

type ChampionsPageProps = {
  searchParams: Promise<{
    role?: string;
  }>;
};

type ChampionTierRow = {
  championName: string;
  role: string;
  tier: string;
  winRate: number;
  pickRate: number;
  banRate: number;
  change: "up" | "down" | "stable";
};

const ROLE_FILTERS = [
  { key: "ALL", label: "All" },
  { key: "TOP", label: "Top" },
  { key: "JUNGLE", label: "Jungle" },
  { key: "MID", label: "Mid" },
  { key: "ADC", label: "ADC" },
  { key: "SUPPORT", label: "Support" },
] as const;

function normalizeRole(role?: string): string {
  const normalized = role?.toUpperCase() ?? "ALL";
  if (normalized === "MIDDLE") return "MID";
  if (normalized === "UTILITY") return "SUPPORT";
  return normalized;
}

function toRate(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed > 1 ? parsed / 100 : parsed;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function tierLabel(tier: string): string {
  const map: Record<string, string> = {
    "1": "S",
    "2": "A",
    "3": "B",
    "4": "C",
    "5": "D",
  };
  return map[tier] ?? tier;
}

async function loadTierList(role: string): Promise<{ source: "opgg" | "wincon"; champions: ChampionTierRow[] }> {
  try {
    const opgg = await opggClient.getTierList(role === "ALL" ? undefined : role);
    if (opgg.champions.length > 0) {
      return { source: "opgg", champions: opgg.champions };
    }
  } catch {
    // Fallback below.
  }

  if (!process.env.DATABASE_URL) {
    return { source: "wincon", champions: [] };
  }

  const currentPatch = await patchTracker.getCurrentPatch();
  const filters = [
    eq(schema.championStats.patch, currentPatch),
    eq(schema.championStats.tier, "ALL"),
    eq(schema.championStats.isStale, false),
  ];
  if (role !== "ALL") {
    filters.push(eq(schema.championStats.role, role));
  }

  const rows = await db
    .select({
      championName: schema.championStats.championName,
      role: schema.championStats.role,
      winRate: schema.championStats.winRate,
      pickRate: schema.championStats.pickRate,
      banRate: schema.championStats.banRate,
    })
    .from(schema.championStats)
    .where(and(...filters))
    .orderBy(desc(schema.championStats.winRate), desc(schema.championStats.gamesPlayed))
    .limit(150);

  return {
    source: "wincon",
    champions: rows.map((row) => ({
      championName: row.championName,
      role: row.role,
      tier: "3",
      winRate: toRate(row.winRate),
      pickRate: toRate(row.pickRate),
      banRate: toRate(row.banRate),
      change: "stable",
    })),
  };
}

export default async function ChampionsPage({ searchParams }: ChampionsPageProps) {
  const { role: rawRole } = await searchParams;
  const selectedRole = normalizeRole(rawRole);
  const { source, champions } = await loadTierList(selectedRole);

  const rowsWithIcons = await Promise.all(
    champions.map(async (entry) => {
      const championData = await getChampionByName(entry.championName).catch(() => undefined);
      return {
        ...entry,
        iconUrl: championData ? getChampionIconUrl(championData.name) : null,
      };
    }),
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Champion Tier List</h1>
        <p className="text-sm text-muted-foreground">
          Current patch snapshot powered by {source === "opgg" ? "OP.GG" : "WinCon collected data"}.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {ROLE_FILTERS.map((role) => (
          <Link
            key={role.key}
            href={role.key === "ALL" ? "/champions" : `/champions?role=${role.key}`}
            className={`rounded-full border px-3 py-1.5 text-sm ${
              selectedRole === role.key
                ? "border-primary bg-primary/20 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {role.label}
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{selectedRole === "ALL" ? "All Roles" : selectedRole} Rankings</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="px-2 py-2">Champion</th>
                <th className="px-2 py-2">Role</th>
                <th className="px-2 py-2">Tier</th>
                <th className="px-2 py-2">Win Rate</th>
                <th className="px-2 py-2">Pick Rate</th>
                <th className="px-2 py-2">Ban Rate</th>
                <th className="px-2 py-2">Trend</th>
              </tr>
            </thead>
            <tbody>
              {rowsWithIcons.map((champion) => (
                <tr key={`${champion.championName}-${champion.role}`} className="border-b border-border/40">
                  <td className="px-2 py-2">
                    <Link
                      href={`/champions/${encodeURIComponent(champion.championName)}?role=${champion.role}`}
                      className="inline-flex items-center gap-2 text-primary hover:underline"
                    >
                      {champion.iconUrl ? (
                        <Image
                          src={champion.iconUrl}
                          alt={champion.championName}
                          width={24}
                          height={24}
                          className="rounded"
                        />
                      ) : (
                        <span className="inline-flex size-6 items-center justify-center rounded bg-muted text-[10px]">
                          {champion.championName.slice(0, 1)}
                        </span>
                      )}
                      <span>{champion.championName}</span>
                    </Link>
                  </td>
                  <td className="px-2 py-2">{champion.role}</td>
                  <td className="px-2 py-2 font-semibold">{tierLabel(champion.tier)}</td>
                  <td className="px-2 py-2">{formatPercent(champion.winRate)}</td>
                  <td className="px-2 py-2">{formatPercent(champion.pickRate)}</td>
                  <td className="px-2 py-2">{formatPercent(champion.banRate)}</td>
                  <td className="px-2 py-2">
                    {champion.change === "up" ? "↑" : champion.change === "down" ? "↓" : "→"}
                  </td>
                </tr>
              ))}
              {rowsWithIcons.length === 0 ? (
                <tr>
                  <td className="px-2 py-6 text-sm text-muted-foreground" colSpan={7}>
                    No champion data available right now.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
