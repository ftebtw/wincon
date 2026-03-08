import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getChampionByName, getChampionIconUrl, getItemIconUrl, getItems } from "@/lib/data-dragon";
import { matchupGuideService } from "@/lib/matchup-guide";
import { opggClient } from "@/lib/opgg-mcp";

type ChampionDetailPageProps = {
  params: Promise<{
    name: string;
  }>;
  searchParams: Promise<{
    role?: string;
  }>;
};

function normalizeRole(role?: string): string {
  const normalized = role?.toUpperCase() ?? "MID";
  if (normalized === "MIDDLE") return "MID";
  if (normalized === "UTILITY") return "SUPPORT";
  if (normalized === "BOTTOM") return "ADC";
  return normalized;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pickPrimaryRole(
  positions: Array<{ position: string; winRate: number; pickRate: number }>,
): string {
  if (positions.length === 0) return "MID";
  return [...positions].sort((a, b) => b.pickRate - a.pickRate)[0]?.position ?? "MID";
}

export async function generateMetadata({ params }: ChampionDetailPageProps): Promise<Metadata> {
  const { name } = await params;
  const championName = decodeURIComponent(name);
  return {
    title: `${championName} Builds, Counters & Tier`,
    description: `${championName} current patch tier, build paths, counters, and matchup guides on WinCon.gg.`,
  };
}

export default async function ChampionDetailPage({
  params,
  searchParams,
}: ChampionDetailPageProps) {
  const [{ name }, { role: rawRole }] = await Promise.all([params, searchParams]);
  const championName = decodeURIComponent(name);
  const positions = await opggClient.getChampionPositions(championName).catch(() => ({
    championName,
    positions: [] as Array<{ position: string; winRate: number; pickRate: number }>,
  }));
  const selectedRole = normalizeRole(rawRole ?? pickPrimaryRole(positions.positions));
  const [meta, analysis, championData, itemsById, guides] = await Promise.all([
    opggClient.getChampionMeta(championName, selectedRole),
    opggClient.getChampionAnalysis(championName, selectedRole),
    getChampionByName(championName).catch(() => undefined),
    getItems().catch(() => new Map<number, { name: string }>()),
    process.env.DATABASE_URL
      ? matchupGuideService.getChampionMatchups(championName, selectedRole).catch(() => [])
      : Promise.resolve([]),
  ]);

  const iconUrl = championData ? getChampionIconUrl(championData.name) : null;
  const coreItems = meta.builds.items.coreItems.slice(0, 4);
  const roleLinks = ["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            {iconUrl ? (
              <Image
                src={iconUrl}
                alt={championName}
                width={72}
                height={72}
                className="rounded-lg"
              />
            ) : (
              <div className="flex size-[72px] items-center justify-center rounded-lg bg-muted text-xl font-semibold">
                {championName.slice(0, 1)}
              </div>
            )}
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">{championName}</h1>
              <p className="text-sm text-muted-foreground">
                {selectedRole} • {formatPercent(meta.winRate)} WR • {formatPercent(meta.pickRate)} PR •{" "}
                {formatPercent(meta.banRate)} BR
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {roleLinks.map((role) => (
              <Link
                key={role}
                href={`/champions/${encodeURIComponent(championName)}?role=${role}`}
                className={`rounded-full border px-3 py-1 text-xs ${
                  selectedRole === role
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-border text-muted-foreground"
                }`}
              >
                {role}
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Optimal Build</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="mb-2 text-xs text-muted-foreground">Core Items</p>
              <div className="flex flex-wrap gap-3">
                {coreItems.map((itemId) => (
                  <div key={itemId} className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1">
                    <Image
                      src={getItemIconUrl(itemId)}
                      alt={itemsById.get(itemId)?.name ?? `Item ${itemId}`}
                      width={28}
                      height={28}
                      className="rounded"
                    />
                    <span className="text-sm">{itemsById.get(itemId)?.name ?? `Item ${itemId}`}</span>
                  </div>
                ))}
                {coreItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Core item data unavailable.</p>
                ) : null}
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs text-muted-foreground">Boots</p>
              {meta.builds.items.boots > 0 ? (
                <div className="inline-flex items-center gap-2 rounded-md border border-border/60 px-2 py-1">
                  <Image
                    src={getItemIconUrl(meta.builds.items.boots)}
                    alt={itemsById.get(meta.builds.items.boots)?.name ?? `Item ${meta.builds.items.boots}`}
                    width={28}
                    height={28}
                    className="rounded"
                  />
                  <span className="text-sm">
                    {itemsById.get(meta.builds.items.boots)?.name ?? `Item ${meta.builds.items.boots}`}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Boot recommendation unavailable.</p>
              )}
            </div>

            <div>
              <p className="text-xs text-muted-foreground">Skill Order</p>
              <p className="text-sm">{meta.builds.skillOrder || "N/A"}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Counters</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs text-muted-foreground">Weak Against</p>
              <ul className="space-y-1 text-sm">
                {analysis.weakAgainst.slice(0, 8).map((counter) => (
                  <li key={`weak-${counter.championName}`}>
                    {counter.championName} ({formatPercent(counter.winRate)})
                  </li>
                ))}
                {analysis.weakAgainst.length === 0 ? (
                  <li className="text-muted-foreground">No weak counter data.</li>
                ) : null}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-xs text-muted-foreground">Strong Against</p>
              <ul className="space-y-1 text-sm">
                {analysis.strongAgainst.slice(0, 8).map((counter) => (
                  <li key={`strong-${counter.championName}`}>
                    {counter.championName} ({formatPercent(counter.winRate)})
                  </li>
                ))}
                {analysis.strongAgainst.length === 0 ? (
                  <li className="text-muted-foreground">No strong counter data.</li>
                ) : null}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Position Win Rates</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="px-2 py-2">Role</th>
                <th className="px-2 py-2">Win Rate</th>
                <th className="px-2 py-2">Pick Rate</th>
              </tr>
            </thead>
            <tbody>
              {positions.positions.map((position) => (
                <tr key={position.position} className="border-b border-border/40">
                  <td className="px-2 py-2">{position.position}</td>
                  <td className="px-2 py-2">{formatPercent(position.winRate)}</td>
                  <td className="px-2 py-2">{formatPercent(position.pickRate)}</td>
                </tr>
              ))}
              {positions.positions.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-2 py-4 text-muted-foreground">
                    Position data unavailable.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>WinCon Matchup Guides</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {guides.slice(0, 12).map((guide) => (
            <Link
              key={guide.id}
              href={`/matchup/${encodeURIComponent(guide.id)}`}
              className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm transition-colors hover:border-primary/70"
            >
              <span>
                {guide.champion} {guide.role} vs {guide.enemy} {guide.enemyRole}
              </span>
              <span className="text-muted-foreground">
                {guide.difficulty} • {formatPercent(guide.winRate)}
              </span>
            </Link>
          ))}
          {guides.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No matchup guides cached for this champion yet. They generate on demand as pages are visited.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
