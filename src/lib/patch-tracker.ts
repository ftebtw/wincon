import Anthropic from "@anthropic-ai/sdk";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { desc, eq, ne } from "drizzle-orm";

import { DataCollector } from "@/lib/data-collector";
import { abilityDataService } from "@/lib/ability-data";
import { getChampions, getItems, getLatestVersion } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";

export interface PatchChange {
  type:
    | "champion_buff"
    | "champion_nerf"
    | "champion_rework"
    | "champion_new"
    | "item_new"
    | "item_removed"
    | "item_changed"
    | "system_change"
    | "dragon_change"
    | "map_change";
  target: string;
  summary: string;
  impact: "high" | "medium" | "low";
}

export interface PatchInfo {
  version: string;
  releaseDate: string;
  changes: PatchChange[];
  rawNotesUrl: string;
  parsedAt: string;
}

interface ParsePatchNotesResponse {
  releaseDate?: string;
  changes?: PatchChange[];
}

type PatchDetection = {
  isNew: boolean;
  version: string;
  previousVersion: string;
};

const SONNET_MODEL = process.env.PATCH_NOTES_MODEL ?? "claude-sonnet-4-5-20250929";
const PATCH_CHECK_LOOKBACK_DAYS = 30;
const CHAMPION_TAGS_PATH = path.join(process.cwd(), "src", "lib", "champion-tags.json");

function toPatchMajorMinor(version: string): string {
  const [major, minor] = version.split(".");
  if (!major || !minor) {
    return version;
  }

  return `${major}.${minor}`;
}

function patchNotesUrlForVersion(version: string): string {
  const normalized = toPatchMajorMinor(version).replace(".", "-");
  return `https://www.leagueoflegends.com/en-us/news/game-updates/patch-${normalized}-notes/`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim(),
  );
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripJsonFences(value: string): string {
  return value.replace(/```json\s*|```\s*/gi, "").trim();
}

function normalizeImpact(value: unknown): PatchChange["impact"] {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  return "medium";
}

function normalizeType(value: unknown): PatchChange["type"] {
  const allowed: PatchChange["type"][] = [
    "champion_buff",
    "champion_nerf",
    "champion_rework",
    "champion_new",
    "item_new",
    "item_removed",
    "item_changed",
    "system_change",
    "dragon_change",
    "map_change",
  ];

  if (typeof value === "string" && allowed.includes(value as PatchChange["type"])) {
    return value as PatchChange["type"];
  }

  return "system_change";
}

function isPatchChange(value: unknown): value is PatchChange {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PatchChange).target === "string" &&
    typeof (value as PatchChange).summary === "string"
  );
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(stripJsonFences(value)) as T;
  } catch {
    return null;
  }
}

function parseFallbackChanges(html: string): PatchChange[] {
  const text = htmlToPlainText(html);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: PatchChange[] = [];

  let section: "champion" | "item" | "system" | "dragon" | "map" | null = null;
  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower.includes("champion") && !lower.includes("championship")) {
      section = "champion";
      continue;
    }

    if (lower.includes("item")) {
      section = "item";
      continue;
    }

    if (lower.includes("dragon")) {
      section = "dragon";
      continue;
    }

    if (lower.includes("map")) {
      section = "map";
      continue;
    }

    if (lower.includes("system") || lower.includes("rune") || lower.includes("jungle")) {
      section = "system";
      continue;
    }

    const shortLine = line.length <= 120;
    const looksLikeName = /^[A-Z][A-Za-z' .-]{1,24}$/.test(line);

    if (section === "champion" && looksLikeName && shortLine) {
      if (lower.includes("new")) {
        changes.push({
          type: "champion_new",
          target: line,
          summary: `${line} added this patch.`,
          impact: "high",
        });
        continue;
      }

      changes.push({
        type: "champion_rework",
        target: line,
        summary: `${line} received notable champion changes.`,
        impact: "medium",
      });
      continue;
    }

    if (section === "item" && looksLikeName && shortLine) {
      changes.push({
        type: "item_changed",
        target: line,
        summary: `${line} was adjusted this patch.`,
        impact: "medium",
      });
      continue;
    }

    if (section === "dragon" && line.length > 10 && line.length < 200) {
      changes.push({
        type: "dragon_change",
        target: "Dragons",
        summary: line,
        impact: "medium",
      });
      continue;
    }

    if (section === "map" && line.length > 10 && line.length < 200) {
      changes.push({
        type: "map_change",
        target: "Map",
        summary: line,
        impact: "medium",
      });
      continue;
    }

    if (section === "system" && line.length > 10 && line.length < 200) {
      changes.push({
        type: "system_change",
        target: "Systems",
        summary: line,
        impact: "low",
      });
    }
  }

  const deduped = new Map<string, PatchChange>();
  for (const change of changes) {
    const key = `${change.type}:${change.target}:${change.summary}`;
    if (!deduped.has(key)) {
      deduped.set(key, change);
    }
  }

  return Array.from(deduped.values()).slice(0, 120);
}

async function parseWithSonnet(html: string, version: string): Promise<ParsePatchNotesResponse | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return null;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const trimmedHtml = html.length > 120_000 ? `${html.slice(0, 120_000)}\n[TRUNCATED]` : html;

  const prompt = `You are parsing League of Legends patch notes HTML.
Return ONLY JSON with this shape:
{
  "releaseDate": "ISO date or empty",
  "changes": [
    {
      "type": "champion_buff|champion_nerf|champion_rework|champion_new|item_new|item_removed|item_changed|system_change|dragon_change|map_change",
      "target": "Champion or item name",
      "summary": "Short precise summary",
      "impact": "high|medium|low"
    }
  ]
}
Patch version: ${version}
HTML:
${trimmedHtml}`;

  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 3000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .map((entry) => (entry.type === "text" ? entry.text : ""))
    .join("\n")
    .trim();

  const parsed = safeJsonParse<ParsePatchNotesResponse>(text);
  if (!parsed || !Array.isArray(parsed.changes)) {
    return null;
  }

  const normalizedChanges = parsed.changes
    .filter((change): change is PatchChange => isPatchChange(change))
    .map((change) => ({
      type: normalizeType(change.type),
      target: change.target.trim(),
      summary: change.summary.trim(),
      impact: normalizeImpact(change.impact),
    }))
    .filter((change) => change.target.length > 0 && change.summary.length > 0);

  return {
    releaseDate: parsed.releaseDate,
    changes: normalizedChanges,
  };
}

export class PatchTracker {
  private inMemoryState: PatchDetection | null = null;

  async getCurrentPatch(): Promise<string> {
    const latest = await getLatestVersion();
    return toPatchMajorMinor(latest);
  }

  async getLatestPatchState(): Promise<typeof schema.patchState.$inferSelect | null> {
    if (!process.env.DATABASE_URL) {
      return null;
    }

    const rows = await db
      .select()
      .from(schema.patchState)
      .orderBy(desc(schema.patchState.detectedAt))
      .limit(1);

    return rows[0] ?? null;
  }

  async detectNewPatch(): Promise<PatchDetection> {
    const version = await this.getCurrentPatch();

    if (!process.env.DATABASE_URL) {
      if (!this.inMemoryState) {
        this.inMemoryState = {
          isNew: false,
          version,
          previousVersion: version,
        };
        return this.inMemoryState;
      }

      const previousVersion = this.inMemoryState.version;
      const isNew = previousVersion !== version;
      this.inMemoryState = { isNew, version, previousVersion };
      return this.inMemoryState;
    }

    const latestState = await this.getLatestPatchState();

    if (!latestState) {
      await db.insert(schema.patchState).values({
        currentVersion: version,
        previousVersion: null,
        detectedAt: new Date(),
        buildStatsStale: false,
        championStatsStale: false,
        collectionStarted: false,
      });

      return {
        isNew: false,
        version,
        previousVersion: version,
      };
    }

    if (latestState.currentVersion !== version) {
      await db.insert(schema.patchState).values({
        currentVersion: version,
        previousVersion: latestState.currentVersion,
        detectedAt: new Date(),
        buildStatsStale: false,
        championStatsStale: false,
        collectionStarted: false,
      });

      return {
        isNew: true,
        version,
        previousVersion: latestState.currentVersion,
      };
    }

    return {
      isNew: false,
      version,
      previousVersion: latestState.previousVersion ?? latestState.currentVersion,
    };
  }

  async fetchPatchNotes(version: string): Promise<PatchInfo> {
    const normalizedVersion = toPatchMajorMinor(version);
    const rawNotesUrl = patchNotesUrlForVersion(normalizedVersion);

    const response = await fetch(rawNotesUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to fetch patch notes (${response.status}) for ${normalizedVersion}`);
    }

    const html = await response.text();
    const sonnetParsed = await parseWithSonnet(html, normalizedVersion).catch((error) => {
      console.warn("[PatchTracker] Sonnet parsing failed, using fallback parser:", error);
      return null;
    });

    const fallbackReleaseDateMatch = html.match(/datetime=["']([^"']+)["']/i);
    const releaseDate =
      sonnetParsed?.releaseDate?.trim() ||
      fallbackReleaseDateMatch?.[1] ||
      new Date().toISOString();

    const fallbackChanges = parseFallbackChanges(html);
    const changes =
      sonnetParsed?.changes && sonnetParsed.changes.length > 0
        ? sonnetParsed.changes
        : fallbackChanges;

    return {
      version: normalizedVersion,
      releaseDate,
      changes,
      rawNotesUrl,
      parsedAt: new Date().toISOString(),
    };
  }

  private async readExistingChampionTags(): Promise<string[]> {
    try {
      await access(CHAMPION_TAGS_PATH);
      const raw = await readFile(CHAMPION_TAGS_PATH, "utf8");
      const parsed = safeJsonParse<{ champions?: Array<{ name?: string }> }>(raw);
      if (!parsed?.champions || !Array.isArray(parsed.champions)) {
        return [];
      }

      return parsed.champions
        .map((entry) => (typeof entry?.name === "string" ? entry.name : ""))
        .filter((entry) => entry.length > 0);
    } catch {
      return [];
    }
  }

  private async refreshChampionTagsSnapshot(newVersion: string): Promise<string[]> {
    const existingChampionNames = await this.readExistingChampionTags();
    const existingSet = new Set(existingChampionNames.map((name) => normalizeName(name)));

    const champions = await getChampions();
    const championList = Array.from(champions.values())
      .map((entry) => ({
        id: entry.id,
        key: entry.key,
        name: entry.name,
        tags: entry.tags,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const newChampions = championList
      .filter((champion) => !existingSet.has(normalizeName(champion.name)))
      .map((champion) => champion.name);

    const payload = {
      patch: newVersion,
      generatedAt: new Date().toISOString(),
      champions: championList,
    };

    try {
      await writeFile(CHAMPION_TAGS_PATH, JSON.stringify(payload, null, 2), "utf8");
    } catch (error) {
      console.warn("[PatchTracker] Failed to write champion-tags snapshot:", error);
    }

    return newChampions;
  }

  async handleNewPatch(newVersion: string): Promise<void> {
    const normalizedVersion = toPatchMajorMinor(newVersion);

    if (!process.env.DATABASE_URL) {
      return;
    }

    await db.update(schema.buildStats).set({ isStale: true }).where(ne(schema.buildStats.patch, normalizedVersion));
    await db
      .update(schema.championStats)
      .set({ isStale: true })
      .where(ne(schema.championStats.patch, normalizedVersion));

    await db
      .update(schema.matchupGuides)
      .set({ patch: "STALE" })
      .where(ne(schema.matchupGuides.patch, normalizedVersion));

    await db
      .update(schema.patchState)
      .set({
        buildStatsStale: true,
        championStatsStale: true,
      })
      .where(eq(schema.patchState.currentVersion, normalizedVersion));

    const existingPatchRows = await db
      .select({ id: schema.patchNotes.id })
      .from(schema.patchNotes)
      .where(eq(schema.patchNotes.version, normalizedVersion))
      .limit(1);

    if (existingPatchRows.length === 0) {
      try {
        const patchInfo = await this.fetchPatchNotes(normalizedVersion);
        await db
          .insert(schema.patchNotes)
          .values({
            version: patchInfo.version,
            releaseDate: new Date(patchInfo.releaseDate),
            changes: patchInfo.changes,
            rawNotesUrl: patchInfo.rawNotesUrl,
            parsedAt: new Date(patchInfo.parsedAt),
          })
          .onConflictDoUpdate({
            target: schema.patchNotes.version,
            set: {
              releaseDate: new Date(patchInfo.releaseDate),
              changes: patchInfo.changes,
              rawNotesUrl: patchInfo.rawNotesUrl,
              parsedAt: new Date(patchInfo.parsedAt),
            },
          });
      } catch (error) {
        console.warn("[PatchTracker] Unable to fetch/store patch notes during handleNewPatch:", error);
      }
    }

    const newChampions = await this.refreshChampionTagsSnapshot(normalizedVersion);
    if (newChampions.length > 0) {
      await db.insert(schema.collectionJobs).values({
        jobType: "comp_classifier_review",
        status: "completed",
        config: {
          patch: normalizedVersion,
          newChampions,
        },
        report: {
          note: "New champions detected from Data Dragon. Review comp-classifier hardcoded lists.",
        },
      });
    }

    try {
      await abilityDataService.fetchAllChampions(true);
    } catch (error) {
      console.warn("[PatchTracker] Failed to refresh ability cache from Meraki:", error);
    }

    await db.insert(schema.collectionJobs).values({
      jobType: "matchup_guide_regeneration_queue",
      status: "completed",
      config: {
        patch: normalizedVersion,
      },
      report: {
        note: "Matchup guides should be regenerated asynchronously for the new patch.",
      },
    });

    try {
      const collector = new DataCollector();
      const report = await collector.runCollection({
        tiers: ["CHALLENGER", "GRANDMASTER", "MASTER"],
        matchesPerPlayer: 10,
        maxTotalMatches: 1000,
        onlyCurrentPatch: true,
        lookbackDays: PATCH_CHECK_LOOKBACK_DAYS,
      });

      await db.insert(schema.collectionJobs).values({
        jobType: "patch_bootstrap_collection",
        status: "completed",
        config: {
          patch: normalizedVersion,
        },
        report,
      });

      await db
        .update(schema.patchState)
        .set({ collectionStarted: true })
        .where(eq(schema.patchState.currentVersion, normalizedVersion));
    } catch (error) {
      await db.insert(schema.collectionJobs).values({
        jobType: "patch_bootstrap_collection",
        status: "failed",
        config: {
          patch: normalizedVersion,
        },
        error: error instanceof Error ? error.message : "Unknown patch bootstrap collection failure.",
      });
    }
  }

  async getPatchContextForChampion(champion: string, patch: string): Promise<string | null> {
    if (!process.env.DATABASE_URL) {
      return null;
    }

    const normalizedPatch = toPatchMajorMinor(patch);
    const rows = await db
      .select({ changes: schema.patchNotes.changes })
      .from(schema.patchNotes)
      .where(eq(schema.patchNotes.version, normalizedPatch))
      .limit(1);

    if (rows.length === 0 || !Array.isArray(rows[0].changes)) {
      return null;
    }

    const normalizedChampion = normalizeName(champion);
    const championChanges = rows[0].changes
      .filter((entry): entry is PatchChange => isPatchChange(entry))
      .filter(
        (change) =>
          change.type.startsWith("champion") &&
          normalizeName(change.target) === normalizedChampion,
      )
      .slice(0, 5);

    if (championChanges.length === 0) {
      return null;
    }

    const summary = championChanges.map((change) => change.summary).join(" | ");
    return `Patch ${normalizedPatch}: ${champion} changes - ${summary}`;
  }

  async getPatchContextForItems(itemIds: number[], patch: string): Promise<string | null> {
    if (!process.env.DATABASE_URL || itemIds.length === 0) {
      return null;
    }

    const normalizedPatch = toPatchMajorMinor(patch);
    const rows = await db
      .select({ changes: schema.patchNotes.changes })
      .from(schema.patchNotes)
      .where(eq(schema.patchNotes.version, normalizedPatch))
      .limit(1);

    if (rows.length === 0 || !Array.isArray(rows[0].changes)) {
      return null;
    }

    const items = await getItems();
    const itemNames = itemIds
      .map((itemId) => items.get(itemId)?.name)
      .filter((name): name is string => Boolean(name));

    if (itemNames.length === 0) {
      return null;
    }

    const nameSet = new Set(itemNames.map((name) => normalizeName(name)));

    const itemChanges = rows[0].changes
      .filter((entry): entry is PatchChange => isPatchChange(entry))
      .filter(
        (change) =>
          change.type === "item_new" ||
          change.type === "item_removed" ||
          change.type === "item_changed",
      )
      .filter((change) => nameSet.has(normalizeName(change.target)))
      .slice(0, 6);

    if (itemChanges.length === 0) {
      return null;
    }

    const summary = itemChanges
      .map((change) => `${change.target}: ${change.summary}`)
      .join(" | ");

    return `Patch ${normalizedPatch}: Item changes relevant to this build - ${summary}`;
  }
}

export const patchTracker = new PatchTracker();
