import { and, desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export interface CDragonChampionSummary {
  id: number;
  name: string;
  alias: string;
  squarePortraitPath: string;
  roles: string[];
}

export interface CDragonAbility {
  name: string;
  description: string;
  cooldowns: number[];
  costs: number[];
  range: number[];
  formulas: Record<string, unknown>;
}

export interface CDragonChampionFull {
  id: number;
  name: string;
  alias: string;
  title: string;
  passive: CDragonAbility;
  spells: CDragonAbility[];
  stats: {
    healthBase: number;
    healthPerLevel: number;
    manaBase: number;
    manaPerLevel: number;
    armorBase: number;
    armorPerLevel: number;
    magicResistBase: number;
    magicResistPerLevel: number;
    attackDamageBase: number;
    attackDamagePerLevel: number;
    attackSpeedBase: number;
    attackSpeedPerLevel: number;
    moveSpeed: number;
    attackRange: number;
    healthRegenBase: number;
    healthRegenPerLevel: number;
    manaRegenBase: number;
    manaRegenPerLevel: number;
  };
}

export interface CDragonItem {
  id: number;
  name: string;
  description: string;
  price: number;
  priceTotal: number;
  from: number[];
  to: number[];
  categories: string[];
  stats: Record<string, number>;
  iconPath?: string;
}

type CDragonVersionName = "latest" | "pbe";
type CDragonCacheEntry<T> = {
  value: T;
  expiresAt: number;
  patch: string;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const LIVE_CACHE_TTL_MS = 24 * ONE_HOUR_MS;
const PBE_CACHE_TTL_MS = 6 * ONE_HOUR_MS;

const ABILITY_CACHE_SOURCE_LIVE = "cdragon_live";
const ABILITY_CACHE_SOURCE_PBE = "cdragon_pbe";

function cacheTtl(version: CDragonVersionName): number {
  return version === "latest" ? LIVE_CACHE_TTL_MS : PBE_CACHE_TTL_MS;
}

function cacheSource(version: CDragonVersionName): string {
  return version === "latest" ? ABILITY_CACHE_SOURCE_LIVE : ABILITY_CACHE_SOURCE_PBE;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry));
  }

  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry));
  }

  return [];
}

function parseAbility(rawAbility: unknown): CDragonAbility {
  const record = (rawAbility as Record<string, unknown>) ?? {};
  const cooldowns = parseNumberArray(record.cooldownCoefficients);
  const costs =
    parseNumberArray(record.costCoefficients).filter((entry) => entry > 0).length > 0
      ? parseNumberArray(record.costCoefficients).filter((entry) => entry > 0)
      : parseNumberArray(record.cost);
  const range = parseNumberArray(record.range).filter((entry) => entry > 0);

  return {
    name: String(record.name ?? "Unknown"),
    description: String(record.dynamicDescription ?? record.description ?? ""),
    cooldowns,
    costs,
    range,
    formulas: {
      coefficients: (record.coefficients as Record<string, unknown>) ?? {},
      effectAmounts: (record.effectAmounts as Record<string, unknown>) ?? {},
      ammo: (record.ammo as Record<string, unknown>) ?? {},
    },
  };
}

function parseChampionStats(rawChampion: Record<string, unknown>): CDragonChampionFull["stats"] {
  const stats = (rawChampion.stats as Record<string, unknown>) ?? {};
  return {
    healthBase: toNumber(stats.healthBase),
    healthPerLevel: toNumber(stats.healthPerLevel),
    manaBase: toNumber(stats.manaBase),
    manaPerLevel: toNumber(stats.manaPerLevel),
    armorBase: toNumber(stats.armorBase),
    armorPerLevel: toNumber(stats.armorPerLevel),
    magicResistBase: toNumber(stats.magicResistBase),
    magicResistPerLevel: toNumber(stats.magicResistPerLevel),
    attackDamageBase: toNumber(stats.attackDamageBase),
    attackDamagePerLevel: toNumber(stats.attackDamagePerLevel),
    attackSpeedBase: toNumber(stats.attackSpeedBase),
    attackSpeedPerLevel: toNumber(stats.attackSpeedPerLevel),
    moveSpeed: toNumber(stats.moveSpeed),
    attackRange: toNumber(stats.attackRange),
    healthRegenBase: toNumber(stats.healthRegenBase),
    healthRegenPerLevel: toNumber(stats.healthRegenPerLevel),
    manaRegenBase: toNumber(stats.manaRegenBase),
    manaRegenPerLevel: toNumber(stats.manaRegenPerLevel),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`CDragon request failed (${response.status}): ${url}`);
  }
  return (await response.json()) as T;
}

export class CommunityDragonService {
  private baseUrl = "https://raw.communitydragon.org";
  private listCache = new Map<CDragonVersionName, CDragonCacheEntry<CDragonChampionSummary[]>>();
  private itemsCache = new Map<CDragonVersionName, CDragonCacheEntry<CDragonItem[]>>();
  private championsCache = new Map<
    CDragonVersionName,
    CDragonCacheEntry<Map<number, CDragonChampionFull>>
  >();
  private championCache = new Map<string, CDragonChampionFull>();
  private contentVersionCache = new Map<CDragonVersionName, CDragonCacheEntry<string>>();

  private async getPatchString(version: CDragonVersionName): Promise<string> {
    const cached = this.contentVersionCache.get(version);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const payload = await fetchJson<{ version?: string }>(
      `${this.baseUrl}/${version}/content-metadata.json`,
    ).catch(() => ({ version: version === "latest" ? "live" : "pbe" }));

    const patch = payload.version ?? (version === "latest" ? "live" : "pbe");
    this.contentVersionCache.set(version, {
      value: patch,
      expiresAt: Date.now() + cacheTtl(version),
      patch,
    });

    return patch;
  }

  async getContentVersion(version: CDragonVersionName = "latest"): Promise<string> {
    return this.getPatchString(version);
  }

  private championKey(championId: number, version: CDragonVersionName): string {
    return `${version}:${championId}`;
  }

  private async loadAllFromDb(version: CDragonVersionName): Promise<Map<number, CDragonChampionFull> | null> {
    if (!process.env.DATABASE_URL) {
      return null;
    }

    const patch = await this.getPatchString(version);
    const rows = await db
      .select({ championData: schema.abilityCache.championData })
      .from(schema.abilityCache)
      .where(
        and(
          eq(schema.abilityCache.patch, patch),
          eq(schema.abilityCache.source, cacheSource(version)),
        ),
      )
      .orderBy(desc(schema.abilityCache.fetchedAt))
      .limit(1);

    if (!rows[0]?.championData || typeof rows[0].championData !== "object") {
      return null;
    }

    const map = new Map<number, CDragonChampionFull>();
    const payload = rows[0].championData as Record<string, CDragonChampionFull>;
    for (const [key, value] of Object.entries(payload)) {
      map.set(Number(key), value);
    }
    return map;
  }

  private async saveAllToDb(
    version: CDragonVersionName,
    champions: Map<number, CDragonChampionFull>,
  ): Promise<void> {
    if (!process.env.DATABASE_URL) {
      return;
    }

    const patch = await this.getPatchString(version);
    await db.insert(schema.abilityCache).values({
      patch,
      source: cacheSource(version),
      championData: Object.fromEntries(champions.entries()),
      fetchedAt: new Date(),
    });
  }

  private parseChampion(raw: Record<string, unknown>): CDragonChampionFull {
    const passive = parseAbility(raw.passive);
    const spells = Array.isArray(raw.spells) ? raw.spells.map((spell) => parseAbility(spell)) : [];

    return {
      id: toNumber(raw.id),
      name: String(raw.name ?? "Unknown"),
      alias: String(raw.alias ?? raw.name ?? "Unknown"),
      title: String(raw.title ?? ""),
      passive,
      spells,
      stats: parseChampionStats(raw),
    };
  }

  async getChampionList(version: CDragonVersionName = "latest"): Promise<CDragonChampionSummary[]> {
    const cached = this.listCache.get(version);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const payload = await fetchJson<Array<Record<string, unknown>>>(
      `${this.baseUrl}/${version}/plugins/rcp-be-lol-game-data/global/default/v1/champion-summary.json`,
    );

    const list = payload
      .map((entry) => ({
        id: toNumber(entry.id),
        name: String(entry.name ?? "Unknown"),
        alias: String(entry.alias ?? entry.name ?? "Unknown"),
        squarePortraitPath: String(entry.squarePortraitPath ?? ""),
        roles: Array.isArray(entry.roles)
          ? entry.roles.map((role) => String(role)).filter((role) => role.length > 0)
          : [],
      }))
      .filter((entry) => entry.id > 0);

    const patch = await this.getPatchString(version);
    this.listCache.set(version, {
      value: list,
      expiresAt: Date.now() + cacheTtl(version),
      patch,
    });
    return list;
  }

  async getChampion(championId: number, version: CDragonVersionName = "latest"): Promise<CDragonChampionFull> {
    const key = this.championKey(championId, version);
    const cached = this.championCache.get(key);
    if (cached) {
      return cached;
    }

    const payload = await fetchJson<Record<string, unknown>>(
      `${this.baseUrl}/${version}/plugins/rcp-be-lol-game-data/global/default/v1/champions/${championId}.json`,
    );
    const champion = this.parseChampion(payload);
    this.championCache.set(key, champion);
    return champion;
  }

  async getItems(version: CDragonVersionName = "latest"): Promise<CDragonItem[]> {
    const cached = this.itemsCache.get(version);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const payload = await fetchJson<Array<Record<string, unknown>>>(
      `${this.baseUrl}/${version}/plugins/rcp-be-lol-game-data/global/default/v1/items.json`,
    );
    const items = payload
      .map((item) => ({
        id: toNumber(item.id),
        name: String(item.name ?? "Unknown"),
        description: String(item.description ?? ""),
        price: toNumber(item.price),
        priceTotal: toNumber(item.priceTotal),
        from: parseNumberArray(item.from),
        to: parseNumberArray(item.to),
        categories: Array.isArray(item.categories)
          ? item.categories.map((category) => String(category))
          : [],
        stats: (item.stats as Record<string, number>) ?? {},
        iconPath: typeof item.iconPath === "string" ? item.iconPath : undefined,
      }))
      .filter((item) => item.id > 0);

    const patch = await this.getPatchString(version);
    this.itemsCache.set(version, {
      value: items,
      expiresAt: Date.now() + cacheTtl(version),
      patch,
    });
    return items;
  }

  async getAllChampions(version: CDragonVersionName = "latest"): Promise<Map<number, CDragonChampionFull>> {
    const cached = this.championsCache.get(version);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const fromDb = await this.loadAllFromDb(version);
    if (fromDb && fromDb.size > 0) {
      const patch = await this.getPatchString(version);
      this.championsCache.set(version, {
        value: fromDb,
        expiresAt: Date.now() + cacheTtl(version),
        patch,
      });
      return fromDb;
    }

    const list = await this.getChampionList(version);
    const ids = list.map((entry) => entry.id).filter((id) => id > 0);
    const map = new Map<number, CDragonChampionFull>();

    const batchSize = 20;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const champions = await Promise.all(
        batch.map((championId) => this.getChampion(championId, version)),
      );

      for (const champion of champions) {
        map.set(champion.id, champion);
      }
    }

    const patch = await this.getPatchString(version);
    this.championsCache.set(version, {
      value: map,
      expiresAt: Date.now() + cacheTtl(version),
      patch,
    });
    void this.saveAllToDb(version, map);
    return map;
  }

  getAssetUrl(path: string, version: CDragonVersionName = "latest"): string {
    if (!path) {
      return "";
    }

    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}/${version}${normalized}`;
  }
}

export const cdragonService = new CommunityDragonService();
