const DATA_DRAGON_BASE_URL = "https://ddragon.leagueoflegends.com";
const VERSION_TTL_MS = 60 * 60 * 1000;

type CachedValue<T> = {
  value: T;
  expiresAt: number;
};

interface ChampionDataDragonEntry {
  id: string;
  key: string;
  name: string;
  title: string;
  tags: string[];
}

interface ItemDataDragonEntry {
  name: string;
  description: string;
  plaintext: string;
  gold: {
    base: number;
    total: number;
    sell: number;
    purchasable: boolean;
  };
  stats: Record<string, number>;
  tags: string[];
}

interface SpellDataDragonEntry {
  id: string;
  key: string;
  name: string;
  description: string;
}

export interface ChampionData {
  id: string;
  key: string;
  name: string;
  title: string;
  tags: string[];
  iconUrl: string;
}

export interface ItemData {
  id: number;
  name: string;
  description: string;
  plaintext: string;
  gold: { base: number; total: number; sell: number; purchasable: boolean };
  stats: Record<string, number>;
  tags: string[];
  iconUrl: string;
}

export interface SpellData {
  id: string;
  key: string;
  name: string;
  description: string;
  iconUrl: string;
}

let versionCache: CachedValue<string> | null = null;
let versionPromise: Promise<string> | null = null;

let championsByKeyCache: Map<string, ChampionData> | null = null;
let championsByNameCache: Map<string, ChampionData> | null = null;
let championsVersion: string | null = null;
let championsPromise: Promise<Map<string, ChampionData>> | null = null;

let itemsCache: Map<number, ItemData> | null = null;
let itemsVersion: string | null = null;
let itemsPromise: Promise<Map<number, ItemData>> | null = null;

let spellsCache: Map<string, SpellData> | null = null;
let spellsVersion: string | null = null;
let spellsPromise: Promise<Map<string, SpellData>> | null = null;

function normalizeChampionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fallbackVersion() {
  return process.env.NEXT_PUBLIC_DATA_DRAGON_VERSION ?? "14.1.1";
}

function getKnownVersion() {
  return versionCache?.value ?? fallbackVersion();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Data Dragon request failed (${response.status}): ${url}`);
  }

  return (await response.json()) as T;
}

export async function getLatestVersion(): Promise<string> {
  if (versionCache && versionCache.expiresAt > Date.now()) {
    return versionCache.value;
  }

  if (versionPromise) {
    return versionPromise;
  }

  versionPromise = (async () => {
    const versions = await fetchJson<string[]>(
      `${DATA_DRAGON_BASE_URL}/api/versions.json`,
    );
    const latest = versions[0];

    if (!latest) {
      throw new Error("No Data Dragon versions available.");
    }

    versionCache = {
      value: latest,
      expiresAt: Date.now() + VERSION_TTL_MS,
    };

    return latest;
  })();

  try {
    return await versionPromise;
  } finally {
    versionPromise = null;
  }
}

export async function getChampions(): Promise<Map<string, ChampionData>> {
  const version = await getLatestVersion();

  if (championsByKeyCache && championsByNameCache && championsVersion === version) {
    return championsByKeyCache;
  }

  if (championsPromise) {
    return championsPromise;
  }

  championsPromise = (async () => {
    const payload = await fetchJson<{
      data: Record<string, ChampionDataDragonEntry>;
    }>(
      `${DATA_DRAGON_BASE_URL}/cdn/${version}/data/en_US/champion.json`,
    );

    const byKey = new Map<string, ChampionData>();
    const byName = new Map<string, ChampionData>();

    for (const champion of Object.values(payload.data)) {
      const mappedChampion: ChampionData = {
        id: champion.id,
        key: champion.key,
        name: champion.name,
        title: champion.title,
        tags: champion.tags,
        iconUrl: `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/champion/${champion.id}.png`,
      };

      byKey.set(mappedChampion.key, mappedChampion);
      byName.set(normalizeChampionName(mappedChampion.name), mappedChampion);
      byName.set(normalizeChampionName(mappedChampion.id), mappedChampion);
    }

    championsByKeyCache = byKey;
    championsByNameCache = byName;
    championsVersion = version;

    return byKey;
  })();

  try {
    return await championsPromise;
  } finally {
    championsPromise = null;
  }
}

export async function getItems(): Promise<Map<number, ItemData>> {
  const version = await getLatestVersion();

  if (itemsCache && itemsVersion === version) {
    return itemsCache;
  }

  if (itemsPromise) {
    return itemsPromise;
  }

  itemsPromise = (async () => {
    const payload = await fetchJson<{
      data: Record<string, ItemDataDragonEntry>;
    }>(`${DATA_DRAGON_BASE_URL}/cdn/${version}/data/en_US/item.json`);

    const map = new Map<number, ItemData>();

    for (const [id, item] of Object.entries(payload.data)) {
      const numericId = Number(id);

      map.set(numericId, {
        id: numericId,
        name: item.name,
        description: item.description,
        plaintext: item.plaintext,
        gold: item.gold,
        stats: item.stats ?? {},
        tags: item.tags ?? [],
        iconUrl: `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/item/${id}.png`,
      });
    }

    itemsCache = map;
    itemsVersion = version;

    return map;
  })();

  try {
    return await itemsPromise;
  } finally {
    itemsPromise = null;
  }
}

export async function getSummonerSpells(): Promise<Map<string, SpellData>> {
  const version = await getLatestVersion();

  if (spellsCache && spellsVersion === version) {
    return spellsCache;
  }

  if (spellsPromise) {
    return spellsPromise;
  }

  spellsPromise = (async () => {
    const payload = await fetchJson<{
      data: Record<string, SpellDataDragonEntry>;
    }>(`${DATA_DRAGON_BASE_URL}/cdn/${version}/data/en_US/summoner.json`);

    const map = new Map<string, SpellData>();

    for (const spell of Object.values(payload.data)) {
      map.set(spell.key, {
        id: spell.id,
        key: spell.key,
        name: spell.name,
        description: spell.description,
        iconUrl: `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/spell/${spell.id}.png`,
      });
    }

    spellsCache = map;
    spellsVersion = version;

    return map;
  })();

  try {
    return await spellsPromise;
  } finally {
    spellsPromise = null;
  }
}

export function getChampionIconUrl(championName: string): string {
  const normalized = normalizeChampionName(championName);
  const champion = championsByNameCache?.get(normalized);

  if (champion) {
    return champion.iconUrl;
  }

  const sanitizedId = championName.replace(/[^A-Za-z0-9]/g, "");
  return `${DATA_DRAGON_BASE_URL}/cdn/${getKnownVersion()}/img/champion/${sanitizedId}.png`;
}

export function getItemIconUrl(itemId: number): string {
  return `${DATA_DRAGON_BASE_URL}/cdn/${getKnownVersion()}/img/item/${itemId}.png`;
}

export function getProfileIconUrl(iconId: number): string {
  return `${DATA_DRAGON_BASE_URL}/cdn/${getKnownVersion()}/img/profileicon/${iconId}.png`;
}

export async function getChampionById(
  championId: number,
): Promise<ChampionData | undefined> {
  const champions = await getChampions();
  return champions.get(String(championId));
}

export async function getChampionByName(
  name: string,
): Promise<ChampionData | undefined> {
  await getChampions();
  return championsByNameCache?.get(normalizeChampionName(name));
}
