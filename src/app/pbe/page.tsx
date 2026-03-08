import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";

import { CopyLinkButton } from "@/components/CopyLinkButton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getChampionIconUrl } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";
import type { PBEChange, PBEDiffReport } from "@/lib/pbe-diff-engine";

type PBEPageProps = {
  searchParams: Promise<{
    puuid?: string;
  }>;
};

function parseDiff(value: unknown): PBEDiffReport | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const report = value as PBEDiffReport;
  if (!Array.isArray(report.championChanges) || !Array.isArray(report.itemChanges)) {
    return null;
  }
  return report;
}

function changeClass(changeType: PBEChange["changeType"]): string {
  if (changeType === "buff" || changeType === "new") return "text-[#10b981]";
  if (changeType === "nerf" || changeType === "removed") return "text-[#ef4444]";
  return "text-muted-foreground";
}

function changeBadge(changeType: PBEChange["changeType"]): "default" | "secondary" | "destructive" | "outline" {
  if (changeType === "buff" || changeType === "new") return "default";
  if (changeType === "nerf" || changeType === "removed") return "destructive";
  return "outline";
}

function groupByTarget(changes: PBEChange[]): Array<{ target: string; changes: PBEChange[]; score: number }> {
  const map = new Map<string, PBEChange[]>();
  for (const change of changes) {
    const list = map.get(change.target) ?? [];
    list.push(change);
    map.set(change.target, list);
  }

  return [...map.entries()]
    .map(([target, grouped]) => ({
      target,
      changes: grouped,
      score: grouped.reduce((sum, change) => sum + Math.abs(change.percentChange ?? 0), 0),
    }))
    .sort((a, b) => b.score - a.score);
}

function countByType(changes: PBEChange[], type: PBEChange["changeType"]): number {
  return changes.filter((change) => change.changeType === type).length;
}

async function getTopChampionsForPlayer(puuid: string): Promise<string[]> {
  if (!process.env.DATABASE_URL || !puuid) {
    return [];
  }

  const rows = await db.execute(sql`
    select champion_name, count(*)::int as games
    from match_participants
    where puuid = ${puuid}
    group by champion_name
    order by games desc
    limit 8
  `);

  return (rows.rows as Array<{ champion_name?: string }>)
    .map((row) => row.champion_name ?? "")
    .filter((name) => name.length > 0);
}

export default async function PBEPage({ searchParams }: PBEPageProps) {
  const { puuid } = await searchParams;

  if (!process.env.DATABASE_URL) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>PBE Preview Unavailable</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            DATABASE_URL is required to read stored PBE diff reports.
          </CardContent>
        </Card>
      </div>
    );
  }

  const latestRows = await db
    .select()
    .from(schema.pbeDiffs)
    .where(eq(schema.pbeDiffs.isLatest, true))
    .orderBy(desc(schema.pbeDiffs.detectedAt))
    .limit(1);

  const latest = latestRows[0];
  if (!latest) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>PBE Preview</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            No PBE changes detected yet. Check back after the next PBE update.
          </CardContent>
        </Card>
      </div>
    );
  }

  const report = parseDiff(latest.diffReport);
  if (!report) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>PBE Preview</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Latest PBE report is malformed.
          </CardContent>
        </Card>
      </div>
    );
  }

  const championGroups = groupByTarget(report.championChanges);
  const itemGroups = groupByTarget(report.itemChanges);
  const detectedDate = latest.detectedAt
    ? new Date(latest.detectedAt).toLocaleString()
    : new Date(report.detectedAt).toLocaleString();

  const topChampions = puuid ? await getTopChampionsForPlayer(puuid) : [];
  const impactedTopChampions = topChampions.filter((champion) =>
    report.championChanges.some((change) => change.target.toLowerCase() === champion.toLowerCase()),
  );

  const currentPath = `/pbe${puuid ? `?puuid=${encodeURIComponent(puuid)}` : ""}`;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>PBE Preview - Upcoming Changes</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline">Live: {report.liveVersion}</Badge>
              <Badge variant="secondary">PBE: {report.pbeVersion}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Detected on {detectedDate}. PBE currently shows {report.totalChanges} total changes.
          </p>
          <Badge variant="destructive">
            PBE changes are not final and may change before going live
          </Badge>
          <div className="pt-1">
            <CopyLinkButton value={currentPath} />
          </div>
        </CardContent>
      </Card>

      <Card className="border-primary/40 bg-primary/10">
        <CardHeader>
          <CardTitle>AI Impact Summary</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {latest.aiAnalysis ?? "AI impact analysis not available yet."}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Champion Changes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {championGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No champion changes detected.</p>
          ) : (
            championGroups.map((group) => {
              const buffs = countByType(group.changes, "buff");
              const nerfs = countByType(group.changes, "nerf");
              const tone =
                buffs > nerfs ? "Buff leaning" : nerfs > buffs ? "Nerf leaning" : "Mixed";

              return (
                <div key={group.target} className="rounded-xl border border-border/70 bg-background/30 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Image
                        src={getChampionIconUrl(group.target)}
                        alt={group.target}
                        width={34}
                        height={34}
                        className="size-9 rounded-md border border-border/70"
                      />
                      <p className="text-sm font-semibold text-foreground">{group.target}</p>
                    </div>
                    <Badge variant="outline">{tone}</Badge>
                  </div>
                  <div className="space-y-1">
                    {group.changes.map((change, index) => (
                      <div key={`${change.field}-${index}`} className="flex flex-wrap items-center gap-2 text-xs">
                        <Badge variant={changeBadge(change.changeType)}>{change.changeType}</Badge>
                        <p className={changeClass(change.changeType)}>{change.humanReadable}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Item Changes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {itemGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No item changes detected.</p>
          ) : (
            itemGroups.map((group) => (
              <div key={group.target} className="rounded-xl border border-border/70 bg-background/30 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">{group.target}</p>
                  <Badge variant="outline">{group.changes.length} changes</Badge>
                </div>
                <div className="space-y-1">
                  {group.changes.map((change, index) => (
                    <div key={`${change.field}-${index}`} className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant={changeBadge(change.changeType)}>{change.changeType}</Badge>
                      {change.changeType === "removed" ? (
                        <p className="text-[#ef4444] line-through">{change.humanReadable}</p>
                      ) : (
                        <p className={changeClass(change.changeType)}>{change.humanReadable}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How This Affects Your Champions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          {puuid ? (
            impactedTopChampions.length > 0 ? (
              impactedTopChampions.map((champion) => (
                <p key={champion}>
                  {champion} has PBE changes detected. Review champion adjustments before your next games.
                </p>
              ))
            ) : (
              <p>
                None of your top tracked champions currently appear in this PBE diff report.
              </p>
            )
          ) : (
            <p>
              Add <code>?puuid=&lt;your_puuid&gt;</code> to personalize this section from your match history.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Link href="/" className="text-sm text-primary hover:underline">
          Back to Home
        </Link>
        <span className="text-muted-foreground">-</span>
        <Link href="/patch" className="text-sm text-primary hover:underline">
          Current Patch Notes
        </Link>
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  title: "PBE Preview - Upcoming LoL Patch Changes",
  description:
    "Upcoming League of Legends patch changes detected from PBE data, including champion and item diffs with AI impact analysis.",
  openGraph: {
    title: "Upcoming LoL Patch Changes - WinCon.gg PBE Preview",
    description:
      "See champion and item changes detected on PBE before they hit live, with AI impact analysis.",
  },
};
