import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db, schema } from "@/lib/db";
import { patchTracker, type PatchChange } from "@/lib/patch-tracker";

function classifyChangeColor(type: PatchChange["type"]): string {
  if (type === "champion_buff" || type === "champion_new" || type === "item_new") {
    return "text-[#10b981]";
  }

  if (type === "champion_nerf" || type === "item_removed") {
    return "text-[#ef4444]";
  }

  return "text-muted-foreground";
}

function impactBadgeVariant(impact: PatchChange["impact"]): "default" | "secondary" | "destructive" | "outline" {
  if (impact === "high") {
    return "destructive";
  }
  if (impact === "medium") {
    return "secondary";
  }
  return "outline";
}

function parseChanges(value: unknown): PatchChange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is PatchChange => {
      return (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as PatchChange).type === "string" &&
        typeof (entry as PatchChange).target === "string" &&
        typeof (entry as PatchChange).summary === "string"
      );
    })
    .slice(0, 300);
}

function recommendationSummary(changes: PatchChange[]): string {
  const championBuffs = changes.filter((change) => change.type === "champion_buff").length;
  const championNerfs = changes.filter((change) => change.type === "champion_nerf").length;
  const itemChanges = changes.filter((change) => change.type.startsWith("item_")).length;
  const systemChanges = changes.filter((change) => change.type === "system_change" || change.type === "dragon_change" || change.type === "map_change").length;

  const lines: string[] = [];
  if (championBuffs > 0 || championNerfs > 0) {
    lines.push(`Champion power shifted this patch (${championBuffs} buffs, ${championNerfs} nerfs), so lane matchup difficulty and comp tags should be interpreted with patch recency in mind.`);
  }

  if (itemChanges > 0) {
    lines.push(`There are ${itemChanges} notable item updates; build recommendations may temporarily favor fallback logic while fresh post-patch data is collected.`);
  }

  if (systemChanges > 0) {
    lines.push(`${systemChanges} system-level updates were detected, so objective timing and macro coaching should be read with patch context enabled.`);
  }

  if (lines.length === 0) {
    return "No major classified patch changes were parsed yet. WinCon.gg will continue collecting current-patch games and refresh recommendations automatically.";
  }

  return lines.join(" ");
}

export default async function PatchPage() {
  const currentPatch = await patchTracker.getCurrentPatch();

  const currentRows = process.env.DATABASE_URL
    ? await db
        .select()
        .from(schema.patchNotes)
        .where(eq(schema.patchNotes.version, currentPatch))
        .limit(1)
    : [];

  const latestRows = process.env.DATABASE_URL
    ? await db
        .select()
        .from(schema.patchNotes)
        .orderBy(desc(schema.patchNotes.parsedAt))
        .limit(1)
    : [];

  const patchNote = currentRows[0] ?? latestRows[0] ?? null;
  const changes = patchNote ? parseChanges(patchNote.changes) : [];

  const championChanges = changes.filter((change) => change.type.startsWith("champion_"));
  const itemChanges = changes.filter((change) => change.type.startsWith("item_"));
  const pbeRows = process.env.DATABASE_URL
    ? await db
        .select({
          totalChanges: schema.pbeDiffs.totalChanges,
          diffReport: schema.pbeDiffs.diffReport,
          detectedAt: schema.pbeDiffs.detectedAt,
        })
        .from(schema.pbeDiffs)
        .where(eq(schema.pbeDiffs.isLatest, true))
        .limit(1)
    : [];
  const pbeTotalChanges = Number(pbeRows[0]?.totalChanges ?? 0);
  const pbeDetectedAt = pbeRows[0]?.detectedAt
    ? new Date(pbeRows[0].detectedAt).toLocaleString()
    : null;

  const releaseDate = patchNote?.releaseDate
    ? new Date(patchNote.releaseDate).toLocaleDateString()
    : "Unknown";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardHeader>
          <CardTitle>Patch Notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2 pb-1">
            <Badge variant="secondary">Current Patch</Badge>
            {pbeRows[0] ? (
              <Link href="/pbe" className="text-primary hover:underline">
                PBE Preview ({pbeTotalChanges} changes)
              </Link>
            ) : null}
          </div>
          <p>
            Current patch: <span className="font-semibold text-foreground">{currentPatch}</span>
          </p>
          <p>
            Notes release date: <span className="font-semibold text-foreground">{releaseDate}</span>
          </p>
          {patchNote?.rawNotesUrl ? (
            <a
              href={patchNote.rawNotesUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              View official patch notes
            </a>
          ) : null}
          {pbeRows[0] ? (
            <p>
              Latest PBE scan:{" "}
              <span className="font-semibold text-foreground">
                {pbeTotalChanges} changes{pbeDetectedAt ? ` (detected ${pbeDetectedAt})` : ""}
              </span>
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How This Affects WinCon.gg Recommendations</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{recommendationSummary(changes)}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Champion Changes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {championChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">No champion changes parsed yet for this patch.</p>
          ) : (
            championChanges.slice(0, 80).map((change, index) => (
              <div key={`${change.target}-${index}`} className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className={`text-sm font-semibold ${classifyChangeColor(change.type)}`}>
                    {change.target}
                  </p>
                  <Badge variant={impactBadgeVariant(change.impact)}>{change.impact}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{change.summary}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Item Changes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {itemChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">No item changes parsed yet for this patch.</p>
          ) : (
            itemChanges.slice(0, 80).map((change, index) => (
              <div key={`${change.target}-${index}`} className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className={`text-sm font-semibold ${classifyChangeColor(change.type)}`}>
                    {change.target}
                  </p>
                  <Badge variant={impactBadgeVariant(change.impact)}>{change.impact}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{change.summary}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
