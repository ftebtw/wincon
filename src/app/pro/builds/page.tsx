import Image from "next/image";
import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getChampionByName, getItemIconUrl } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";
import { getProBuildsForChampion } from "@/lib/pro-insights";

type ProBuildsPageProps = {
  searchParams: Promise<{
    champion?: string;
    role?: string;
    league?: string;
    patch?: string;
  }>;
};

const ROLES = ["TOP", "JNG", "MID", "BOT", "SUP"];

function normalizeRole(value: string | undefined): string {
  const normalized = (value ?? "").trim().toUpperCase();
  if (normalized === "ADC" || normalized === "BOTTOM") {
    return "BOT";
  }
  if (normalized === "JUNGLE") {
    return "JNG";
  }
  if (normalized === "MIDDLE") {
    return "MID";
  }
  if (normalized === "SUPPORT" || normalized === "UTILITY") {
    return "SUP";
  }
  if (ROLES.includes(normalized)) {
    return normalized;
  }
  return "MID";
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export default async function ProBuildsPage({ searchParams }: ProBuildsPageProps) {
  const { champion: championParam, role: roleParam, league, patch } = await searchParams;

  const championRows = await db.execute(sql`
    select champion, count(*)::int as games
    from pro_player_stats
    where position <> 'TEAM'
    group by champion
    order by games desc
    limit 80
  `);

  const champions = championRows.rows
    .map((row) => ({
      champion: String((row as { champion?: unknown }).champion ?? ""),
      games: Number((row as { games?: unknown }).games ?? 0),
    }))
    .filter((row) => row.champion.length > 0);

  const selectedChampion = championParam
    ? decodeURIComponent(championParam)
    : champions[0]?.champion ?? "Azir";

  const selectedRole = normalizeRole(roleParam);

  const builds = await getProBuildsForChampion({
    champion: selectedChampion,
    role: selectedRole,
    league,
    patch,
    recentGames: 350,
  });

  const championData = await getChampionByName(selectedChampion);
  const championId = Number(championData?.key ?? 0);

  const [soloQueueBaseline] = championId > 0
    ? await db
        .select({
          itemBuildPath: schema.buildStats.itemBuildPath,
          winRate: schema.buildStats.winRate,
          sampleSize: schema.buildStats.sampleSize,
          patch: schema.buildStats.patch,
        })
        .from(schema.buildStats)
        .where(eq(schema.buildStats.championId, championId))
        .orderBy(desc(schema.buildStats.winRate), desc(schema.buildStats.sampleSize))
        .limit(1)
    : [];

  const [latestPatchState] = process.env.DATABASE_URL
    ? await db
        .select()
        .from(schema.patchState)
        .orderBy(desc(schema.patchState.detectedAt))
        .limit(1)
    : [];

  const currentPatch = latestPatchState?.currentVersion ?? null;
  const showStaleWarning =
    Boolean(latestPatchState?.buildStatsStale) ||
    Boolean(
      currentPatch &&
        soloQueueBaseline?.patch &&
        soloQueueBaseline.patch !== currentPatch,
    );

  const proTop = builds[0];
  const soloPath = Array.isArray(soloQueueBaseline?.itemBuildPath)
    ? soloQueueBaseline.itemBuildPath.map((item) => Number(item)).filter((item): item is number => Number.isFinite(item) && item > 0)
    : [];

  let comparisonText = "Not enough solo queue baseline data to compare yet.";
  if (proTop && soloPath.length > 0) {
    const proFirst = proTop.buildPath[0];
    const soloFirst = soloPath[0];
    comparisonText = proFirst === soloFirst
      ? `Pro and solo queue both start with Item ${proFirst} most often on ${selectedChampion}.`
      : `Pro starts skew toward Item ${proFirst} while solo queue favors Item ${soloFirst}, indicating different risk profiles.`;
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardHeader>
          <CardTitle>Pro Builds</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {ROLES.map((role) => (
              <Link
                key={role}
                href={`/pro/builds?champion=${encodeURIComponent(selectedChampion)}&role=${role}${league ? `&league=${encodeURIComponent(league)}` : ""}${patch ? `&patch=${encodeURIComponent(patch)}` : ""}`}
                className={`rounded-full border px-3 py-1 text-sm ${selectedRole === role ? "border-primary bg-primary/20 text-primary" : "border-border text-muted-foreground"}`}
              >
                {role}
              </Link>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {champions.slice(0, 24).map((entry) => (
              <Link
                key={entry.champion}
                href={`/pro/builds?champion=${encodeURIComponent(entry.champion)}&role=${selectedRole}${league ? `&league=${encodeURIComponent(league)}` : ""}${patch ? `&patch=${encodeURIComponent(patch)}` : ""}`}
                className={`rounded border px-2 py-1 text-xs ${selectedChampion === entry.champion ? "border-primary text-primary" : "border-border text-muted-foreground"}`}
              >
                {entry.champion}
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {selectedChampion} ({selectedRole})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {showStaleWarning && currentPatch ? (
            <div className="rounded-md border border-[#f59e0b]/50 bg-[#f59e0b]/10 px-3 py-2 text-xs text-[#fde68a]">
              Build data is from patch {soloQueueBaseline?.patch ?? "unknown"}. New patch {currentPatch} may have changed optimal builds. Updated stats coming soon.
            </div>
          ) : null}
          {builds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pro build data imported yet for this selection.</p>
          ) : (
            builds.slice(0, 8).map((build, index) => (
              <div key={`${selectedChampion}-${index}`} className="rounded-md border border-border/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {build.buildPath.slice(0, 6).map((itemId) => (
                    <Image
                      key={`${index}-${itemId}`}
                      src={getItemIconUrl(itemId)}
                      alt={`Item ${itemId}`}
                      width={36}
                      height={36}
                      className="size-9 rounded"
                    />
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">{build.games} games</Badge>
                  <Badge variant="secondary">{pct(build.winRate)} WR</Badge>
                  {build.patches.slice(0, 2).map((entryPatch) => (
                    <Badge key={`${index}-patch-${entryPatch}`} variant="outline">
                      Patch {entryPatch}
                    </Badge>
                  ))}
                  {build.leagues.slice(0, 3).map((entryLeague) => (
                    <Badge key={`${index}-${entryLeague}`} variant="outline">
                      {entryLeague}
                    </Badge>
                  ))}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rune Pages and Summoner Spells</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Oracles Elixir import currently prioritizes core combat and economy metrics. Rune and spell trend extraction is scheduled for the next iteration.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pro vs Solo Queue Meta</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>{comparisonText}</p>
          {soloQueueBaseline ? (
            <p>
              Solo queue baseline sample: {soloQueueBaseline.sampleSize} games, {pct(Number(soloQueueBaseline.winRate ?? 0))} WR (patch {soloQueueBaseline.patch}).
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
