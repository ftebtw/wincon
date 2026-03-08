import { and, desc, eq } from "drizzle-orm";

import { getLatestVersion } from "@/lib/data-dragon";
import { db, schema } from "@/lib/db";

export interface AbilityData {
  name: string;
  slot: "P" | "Q" | "W" | "E" | "R";
  cooldown: number[];
  cost: number[];
  costType: string;
  range: number;
  effects: {
    description: string;
    damage?: number[];
    apRatio?: number;
    adRatio?: number;
    hpRatio?: number;
    ccDuration?: number[];
  }[];
}

export interface ChampionAbilities {
  champion: string;
  passive: AbilityData;
  Q: AbilityData;
  W: AbilityData;
  E: AbilityData;
  R: AbilityData;
  stats: {
    health: { base: number; perLevel: number };
    attackDamage: { base: number; perLevel: number };
    armor: { base: number; perLevel: number };
    magicResist: { base: number; perLevel: number };
    attackSpeed: { base: number; perLevel: number };
    moveSpeed: number;
    attackRange: number;
  };
}

export interface TradeWindowAnalysis {
  bestTradeWindow: string;
  allInWinner: string;
  dangerAbility: string;
  keyTimings: { ability: string; cooldown: number; window: string }[];
}

export interface PowerSpike {
  level: number;
  minute: number;
  description: string;
  relativeStrength: "weaker" | "even" | "stronger";
}

type AbilitySlot = "P" | "Q" | "W" | "E" | "R";

const MERAKI_CHAMPIONS_URL =
  "https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json";
const ABILITY_CACHE_SOURCE = "meraki";

const CC_TERMS = [
  "stun",
  "root",
  "snare",
  "slow",
  "charm",
  "fear",
  "taunt",
  "silence",
  "suppression",
  "knockup",
  "airborne",
];

const IMPORTANT_SLOTS: Array<"Q" | "W" | "E" | "R"> = ["Q", "W", "E", "R"];

const SKILL_PRIORITIES: Record<string, Array<"Q" | "W" | "E">> = {
  aatrox: ["Q", "E", "W"],
  ahri: ["Q", "W", "E"],
  akali: ["Q", "E", "W"],
  caitlyn: ["Q", "W", "E"],
  darius: ["Q", "W", "E"],
  ezreal: ["Q", "E", "W"],
  fiora: ["Q", "E", "W"],
  fizz: ["E", "W", "Q"],
  garen: ["E", "Q", "W"],
  jinx: ["Q", "W", "E"],
  kaisa: ["Q", "E", "W"],
  leblanc: ["W", "Q", "E"],
  lucian: ["Q", "E", "W"],
  nautilus: ["E", "Q", "W"],
  riven: ["Q", "E", "W"],
  sett: ["Q", "W", "E"],
  syndra: ["Q", "W", "E"],
  vayne: ["W", "Q", "E"],
  vex: ["Q", "W", "E"],
  xayah: ["E", "W", "Q"],
  yasuo: ["Q", "E", "W"],
  yone: ["Q", "E", "W"],
  zed: ["Q", "E", "W"],
};

let cachedPatch: string | null = null;
let cachedAt = 0;
let cachedChampions: Map<string, ChampionAbilities> | null = null;
let inflightLoad: Promise<Map<string, ChampionAbilities>> | null = null;

function toPatchMajorMinor(version: string): string {
  const [major, minor] = version.split(".");
  if (!major || !minor) {
    return version;
  }
  return `${major}.${minor}`;
}

function normalizeChampionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumberArray(value: unknown): number[] {
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry));
  }

  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry)) as number[];
}

function parseScalableValues(source: unknown): number[] {
  if (!source) {
    return [];
  }

  if (Array.isArray(source) || typeof source === "string") {
    return toNumberArray(source);
  }

  if (typeof source === "object") {
    const record = source as Record<string, unknown>;
    if (Array.isArray(record.values) || typeof record.values === "string") {
      return toNumberArray(record.values);
    }

    const modifiers = Array.isArray(record.modifiers) ? record.modifiers : [];
    for (const modifier of modifiers) {
      if (modifier && typeof modifier === "object") {
        const values = (modifier as Record<string, unknown>).values;
        if (Array.isArray(values) || typeof values === "string") {
          return toNumberArray(values);
        }
      }
    }
  }

  return [];
}

function parseRange(source: unknown): number {
  if (typeof source === "number") {
    return source;
  }

  if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    if (typeof record.flat === "number") {
      return record.flat;
    }
  }

  return 0;
}

function parseScalingStat(source: unknown): { base: number; perLevel: number } {
  if (!source || typeof source !== "object") {
    return { base: 0, perLevel: 0 };
  }

  const record = source as Record<string, unknown>;
  return {
    base: toNumber(record.flat),
    perLevel: toNumber(record.perLevel),
  };
}

function parseRatioFromModifier(modifier: unknown): {
  apRatio?: number;
  adRatio?: number;
  hpRatio?: number;
} {
  if (!modifier || typeof modifier !== "object") {
    return {};
  }

  const record = modifier as Record<string, unknown>;
  const units = Array.isArray(record.units) ? record.units : [];
  const values = toNumberArray(record.values);
  const unitString = String(units[0] ?? "").toLowerCase();
  const value = values[0];

  if (!Number.isFinite(value) || value === 0) {
    return {};
  }

  const ratio = Math.abs(value) > 1 ? value / 100 : value;
  if (unitString.includes("ap")) {
    return { apRatio: ratio };
  }
  if (unitString.includes("ad")) {
    return { adRatio: ratio };
  }
  if (unitString.includes("health") || unitString.includes("hp")) {
    return { hpRatio: ratio };
  }
  return {};
}

function pickPrimaryAbility(rawAbility: unknown): Record<string, unknown> {
  if (Array.isArray(rawAbility)) {
    const first = rawAbility[0];
    if (first && typeof first === "object") {
      return first as Record<string, unknown>;
    }
    return {};
  }

  if (rawAbility && typeof rawAbility === "object") {
    return rawAbility as Record<string, unknown>;
  }

  return {};
}

function parseEffects(source: unknown): AbilityData["effects"] {
  if (!Array.isArray(source)) {
    return [];
  }

  const parsedEffects: AbilityData["effects"] = [];

  for (const effect of source) {
    if (!effect || typeof effect !== "object") {
      continue;
    }

    const record = effect as Record<string, unknown>;
    const description = String(record.description ?? "").trim();
    const leveling = Array.isArray(record.leveling) ? record.leveling : [];

    let damage: number[] | undefined;
    let ccDuration: number[] | undefined;
    let apRatio: number | undefined;
    let adRatio: number | undefined;
    let hpRatio: number | undefined;

    for (const levelEntry of leveling) {
      if (!levelEntry || typeof levelEntry !== "object") {
        continue;
      }
      const levelRecord = levelEntry as Record<string, unknown>;
      const attribute = String(levelRecord.attribute ?? "").toLowerCase();
      const modifiers = Array.isArray(levelRecord.modifiers) ? levelRecord.modifiers : [];

      if (!damage && attribute.includes("damage")) {
        const primary = modifiers[0] as unknown;
        const values = parseScalableValues(primary);
        if (values.length > 0) {
          damage = values;
        }
      }

      if (!ccDuration && CC_TERMS.some((term) => attribute.includes(term))) {
        const primary = modifiers[0] as unknown;
        const values = parseScalableValues(primary);
        if (values.length > 0) {
          ccDuration = values;
        }
      }

      for (const modifier of modifiers) {
        const ratio = parseRatioFromModifier(modifier);
        if (ratio.apRatio !== undefined && apRatio === undefined) apRatio = ratio.apRatio;
        if (ratio.adRatio !== undefined && adRatio === undefined) adRatio = ratio.adRatio;
        if (ratio.hpRatio !== undefined && hpRatio === undefined) hpRatio = ratio.hpRatio;
      }
    }

    parsedEffects.push({
      description,
      damage,
      apRatio,
      adRatio,
      hpRatio,
      ccDuration,
    });
  }

  return parsedEffects;
}

function parseAbility(
  championResource: string,
  slot: AbilitySlot,
  rawAbility: unknown,
): AbilityData {
  const raw = pickPrimaryAbility(rawAbility);
  const costType =
    typeof raw.resource === "string"
      ? raw.resource
      : championResource
        ? championResource
        : "None";

  return {
    name: String(raw.name ?? `${slot} Ability`),
    slot,
    cooldown: parseScalableValues(raw.cooldown),
    cost: parseScalableValues(raw.cost),
    costType,
    range: parseRange(raw.targetRange ?? raw.range ?? raw.effectRadius ?? raw.width),
    effects: parseEffects(raw.effects),
  };
}

function parseChampionAbilities(
  championName: string,
  payload: unknown,
): ChampionAbilities | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const abilities = (raw.abilities as Record<string, unknown>) ?? {};
  const stats = (raw.stats as Record<string, unknown>) ?? {};
  const championResource = String(raw.resource ?? "None");

  const parsed: ChampionAbilities = {
    champion: String(raw.name ?? championName),
    passive: parseAbility(championResource, "P", abilities.P),
    Q: parseAbility(championResource, "Q", abilities.Q),
    W: parseAbility(championResource, "W", abilities.W),
    E: parseAbility(championResource, "E", abilities.E),
    R: parseAbility(championResource, "R", abilities.R),
    stats: {
      health: parseScalingStat(stats.health),
      attackDamage: parseScalingStat(stats.attackDamage),
      armor: parseScalingStat(stats.armor),
      magicResist: parseScalingStat(stats.magicResistance),
      attackSpeed: parseScalingStat(stats.attackSpeed),
      moveSpeed: toNumber((stats.movespeed as Record<string, unknown> | undefined)?.flat),
      attackRange: toNumber((stats.attackRange as Record<string, unknown> | undefined)?.flat),
    },
  };

  return parsed;
}

function abilityDamageAtRank(ability: AbilityData, rank: number): number {
  const safeRank = Math.max(1, rank);
  let best = 0;
  for (const effect of ability.effects) {
    if (!effect.damage || effect.damage.length === 0) {
      continue;
    }
    const value = effect.damage[Math.min(safeRank - 1, effect.damage.length - 1)] ?? 0;
    if (value > best) {
      best = value;
    }
  }
  return best;
}

function abilityCcAtRank(ability: AbilityData, rank: number): number {
  const safeRank = Math.max(1, rank);
  let best = 0;
  for (const effect of ability.effects) {
    if (!effect.ccDuration || effect.ccDuration.length === 0) {
      continue;
    }
    const value = effect.ccDuration[Math.min(safeRank - 1, effect.ccDuration.length - 1)] ?? 0;
    if (value > best) {
      best = value;
    }
  }
  return best;
}

function championSkillOrder(champion: string): Array<"Q" | "W" | "E"> {
  const key = normalizeChampionName(champion);
  return SKILL_PRIORITIES[key] ?? ["Q", "W", "E"];
}

function estimateSkillRanks(
  champion: string,
  level: number,
): Record<"Q" | "W" | "E" | "R", number> {
  const clampedLevel = Math.max(1, Math.min(18, level));
  const order = championSkillOrder(champion);
  const ranks: Record<"Q" | "W" | "E" | "R", number> = {
    Q: 0,
    W: 0,
    E: 0,
    R: 0,
  };

  if (clampedLevel >= 6) ranks.R = 1;
  if (clampedLevel >= 11) ranks.R = 2;
  if (clampedLevel >= 16) ranks.R = 3;

  const basicPoints = clampedLevel - ranks.R;
  const uniqueSlots = [order[0], order[1], order[2]];

  let spent = 0;
  for (const slot of uniqueSlots) {
    if (spent >= basicPoints) break;
    ranks[slot] += 1;
    spent += 1;
  }

  while (spent < basicPoints) {
    for (const slot of order) {
      if (spent >= basicPoints) break;
      if (ranks[slot] < 5) {
        ranks[slot] += 1;
        spent += 1;
      }
    }
  }

  return ranks;
}

function getAbilityAtSlot(champion: ChampionAbilities, slot: AbilitySlot): AbilityData {
  if (slot === "P") return champion.passive;
  if (slot === "Q") return champion.Q;
  if (slot === "W") return champion.W;
  if (slot === "E") return champion.E;
  return champion.R;
}

function describeAbilityForPrompt(
  champion: ChampionAbilities,
  slot: AbilitySlot,
  rank: number,
): string {
  const ability = getAbilityAtSlot(champion, slot);
  const cd = ability.cooldown.length > 0
    ? ability.cooldown[Math.min(Math.max(rank, 1) - 1, ability.cooldown.length - 1)]
    : 0;
  const dmg = abilityDamageAtRank(ability, Math.max(rank, 1));
  const ratioBits: string[] = [];
  for (const effect of ability.effects) {
    if (effect.apRatio !== undefined) ratioBits.push(`${effect.apRatio.toFixed(2)} AP`);
    if (effect.adRatio !== undefined) ratioBits.push(`${effect.adRatio.toFixed(2)} AD`);
    if (effect.hpRatio !== undefined) ratioBits.push(`${effect.hpRatio.toFixed(2)} HP`);
  }
  const ratio = ratioBits.length > 0 ? ` + ${Array.from(new Set(ratioBits)).join(" + ")}` : "";
  return `${slot}: ${cd}s CD${dmg > 0 ? ` ${Math.round(dmg)} dmg${ratio}` : ""}`;
}

export class AbilityDataService {
  private async getPatchVersion(): Promise<string> {
    const latest = await getLatestVersion();
    return toPatchMajorMinor(latest);
  }

  private async loadFromDb(patch: string): Promise<Map<string, ChampionAbilities> | null> {
    if (!process.env.DATABASE_URL) {
      return null;
    }

    try {
      const rows = await db
        .select({ championData: schema.abilityCache.championData })
        .from(schema.abilityCache)
        .where(
          and(
            eq(schema.abilityCache.patch, patch),
            eq(schema.abilityCache.source, ABILITY_CACHE_SOURCE),
          ),
        )
        .orderBy(desc(schema.abilityCache.fetchedAt))
        .limit(1);
      if (!rows[0]?.championData || typeof rows[0].championData !== "object") {
        return null;
      }

      const payload = rows[0].championData as Record<string, ChampionAbilities>;
      const map = new Map<string, ChampionAbilities>();
      for (const [key, value] of Object.entries(payload)) {
        map.set(key, value);
      }
      return map;
    } catch (error) {
      console.warn("[AbilityDataService] Failed to read ability cache from DB:", error);
      return null;
    }
  }

  private async saveToDb(
    patch: string,
    champions: Map<string, ChampionAbilities>,
  ): Promise<void> {
    if (!process.env.DATABASE_URL) {
      return;
    }

    try {
      await db.insert(schema.abilityCache).values({
        patch,
        source: ABILITY_CACHE_SOURCE,
        championData: Object.fromEntries(champions.entries()),
        fetchedAt: new Date(),
      });
    } catch (error) {
      console.warn("[AbilityDataService] Failed to persist ability cache:", error);
    }
  }

  async fetchAllChampions(forceRefresh = false): Promise<Map<string, ChampionAbilities>> {
    if (!forceRefresh && cachedPatch && cachedChampions) {
      const ageMs = Date.now() - cachedAt;
      if (ageMs < 60 * 60 * 1000) {
        return cachedChampions;
      }
    }

    if (inflightLoad) {
      return inflightLoad;
    }

    inflightLoad = (async () => {
      const patch = await this.getPatchVersion();
      if (!forceRefresh && cachedPatch === patch && cachedChampions) {
        return cachedChampions;
      }

      try {
        const response = await fetch(MERAKI_CHAMPIONS_URL, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Meraki fetch failed (${response.status})`);
        }

        const payload = (await response.json()) as Record<string, unknown>;
        const map = new Map<string, ChampionAbilities>();
        for (const [championName, championPayload] of Object.entries(payload)) {
          const parsed = parseChampionAbilities(championName, championPayload);
          if (!parsed) {
            continue;
          }

          const normalized = normalizeChampionName(parsed.champion);
          map.set(normalized, parsed);
          map.set(normalizeChampionName(championName), parsed);
        }

        if (map.size === 0) {
          throw new Error("Meraki ability payload did not contain champion data.");
        }

        cachedPatch = patch;
        cachedAt = Date.now();
        cachedChampions = map;
        void this.saveToDb(patch, map);
        return map;
      } catch (error) {
        console.warn("[AbilityDataService] Meraki fetch failed, trying DB cache:", error);
        const cached = await this.loadFromDb(patch);
        if (!cached) {
          throw error;
        }
        cachedPatch = patch;
        cachedAt = Date.now();
        cachedChampions = cached;
        return cached;
      } finally {
        inflightLoad = null;
      }
    })();

    return inflightLoad;
  }

  async getChampionAbilities(champion: string): Promise<ChampionAbilities> {
    const champions = await this.fetchAllChampions();
    const normalized = normalizeChampionName(champion);
    const found = champions.get(normalized);
    if (!found) {
      throw new Error(`Champion ability data not found: ${champion}`);
    }
    return found;
  }

  getTradeWindows(champion1: string, champion2: string, level: number): TradeWindowAnalysis {
    if (!cachedChampions) {
      throw new Error("Ability cache not loaded. Call fetchAllChampions() first.");
    }

    const c1 = cachedChampions.get(normalizeChampionName(champion1));
    const c2 = cachedChampions.get(normalizeChampionName(champion2));
    if (!c1 || !c2) {
      throw new Error(`Missing ability data for matchup ${champion1} vs ${champion2}`);
    }

    const ranks1 = estimateSkillRanks(c1.champion, level);
    const ranks2 = estimateSkillRanks(c2.champion, level);

    const c2CooldownEntries = IMPORTANT_SLOTS.map((slot) => {
      const ability = getAbilityAtSlot(c2, slot);
      const rank = slot === "R" ? ranks2.R : ranks2[slot];
      const cooldown = ability.cooldown.length > 0
        ? ability.cooldown[Math.min(Math.max(rank, 1) - 1, ability.cooldown.length - 1)]
        : 0;
      const damage = abilityDamageAtRank(ability, Math.max(rank, 1));
      const cc = abilityCcAtRank(ability, Math.max(rank, 1));
      return { slot, ability, cooldown, damage, cc };
    });

    const primaryEnemyWindow = [...c2CooldownEntries]
      .filter((entry) => entry.slot !== "R")
      .sort((a, b) => b.cooldown - a.cooldown)[0];

    const bestTradeWindow = primaryEnemyWindow
      ? `After ${c2.champion} uses ${primaryEnemyWindow.slot} (${primaryEnemyWindow.ability.name}), you have about ${Math.round(primaryEnemyWindow.cooldown)}s to trade while that tool is down.`
      : "Track the enemy's major cooldowns and trade when they are unavailable.";

    const estimateBurst = (
      champion: ChampionAbilities,
      ranks: Record<"Q" | "W" | "E" | "R", number>,
    ) => {
      let total = 0;
      for (const slot of IMPORTANT_SLOTS) {
        const rank = ranks[slot];
        if (rank <= 0) continue;
        total += abilityDamageAtRank(getAbilityAtSlot(champion, slot), rank);
      }
      return total;
    };

    const burst1 = estimateBurst(c1, ranks1);
    const burst2 = estimateBurst(c2, ranks2);
    const allInWinner =
      burst1 >= burst2
        ? `${c1.champion} has the higher raw all-in at level ${level} (${Math.round(burst1)} vs ${Math.round(burst2)}).`
        : `${c2.champion} has the higher raw all-in at level ${level} (${Math.round(burst2)} vs ${Math.round(burst1)}).`;

    const dangerAbilityEntry = [...c2CooldownEntries].sort((a, b) => {
      const scoreA = a.damage + a.cc * 120 + a.cooldown * 2;
      const scoreB = b.damage + b.cc * 120 + b.cooldown * 2;
      return scoreB - scoreA;
    })[0];

    const dangerAbility = dangerAbilityEntry
      ? `${c2.champion} ${dangerAbilityEntry.slot} (${dangerAbilityEntry.ability.name}) is the key threat.`
      : `${c2.champion}'s key cooldown is their primary threat tool.`;

    const keyTimings = c2CooldownEntries
      .sort((a, b) => b.cooldown - a.cooldown)
      .slice(0, 4)
      .map((entry) => ({
        ability: `${c2.champion} ${entry.slot} (${entry.ability.name})`,
        cooldown: entry.cooldown,
        window: `If baited, trade for ${Math.max(1, Math.round(entry.cooldown))}s.`,
      }));

    return {
      bestTradeWindow,
      allInWinner,
      dangerAbility,
      keyTimings,
    };
  }

  getPowerSpikes(champion: string, role: string): PowerSpike[] {
    const normalizedChampion = normalizeChampionName(champion);
    const normalizedRole = role.toUpperCase();
    const lateGameCarry = [
      "jinx",
      "kassadin",
      "kayle",
      "vayne",
      "kogmaw",
      "veigar",
      "senna",
    ].includes(normalizedChampion);
    const earlySkirmisher = [
      "renekton",
      "lucian",
      "draven",
      "lee sin",
      "pantheon",
      "riven",
      "jayce",
    ]
      .map(normalizeChampionName)
      .includes(normalizedChampion);

    const spikes: PowerSpike[] = [
      {
        level: 2,
        minute: 3,
        description: `Level 2 spike - ${champion} unlocks two-ability trades.`,
        relativeStrength: earlySkirmisher ? "stronger" : "even",
      },
      {
        level: 3,
        minute: 4,
        description: `Level 3 spike - full basic kit available for ${champion}.`,
        relativeStrength: earlySkirmisher ? "stronger" : "even",
      },
      {
        level: 6,
        minute: 8,
        description: `Level 6 spike - ultimate unlock significantly changes kill threat.`,
        relativeStrength: lateGameCarry ? "even" : "stronger",
      },
      {
        level: 11,
        minute: 16,
        description: `Level 11 spike - rank 2 ultimate and midgame fight power.`,
        relativeStrength: lateGameCarry ? "stronger" : "even",
      },
      {
        level: 16,
        minute: 26,
        description: `Level 16 spike - rank 3 ultimate and late game execution windows.`,
        relativeStrength: lateGameCarry ? "stronger" : "even",
      },
      {
        level: 0,
        minute: 11,
        description: `${champion} first-item completion window (typically 10-12 min in ${normalizedRole}).`,
        relativeStrength: "even",
      },
      {
        level: 0,
        minute: 20,
        description: `${champion} two-item spike (typically 18-22 min).`,
        relativeStrength: lateGameCarry ? "stronger" : "even",
      },
    ];

    return spikes;
  }

  formatForPrompt(champion: string, enemyChampion: string, level: number): string {
    if (!cachedChampions) {
      throw new Error("Ability cache not loaded. Call fetchAllChampions() first.");
    }

    const player = cachedChampions.get(normalizeChampionName(champion));
    const enemy = cachedChampions.get(normalizeChampionName(enemyChampion));
    if (!player || !enemy) {
      return `Ability context unavailable for ${champion} vs ${enemyChampion}.`;
    }

    const playerRanks = estimateSkillRanks(player.champion, level);
    const enemyRanks = estimateSkillRanks(enemy.champion, level);
    const trade = this.getTradeWindows(player.champion, enemy.champion, level);

    const playerLine = IMPORTANT_SLOTS.map((slot) =>
      describeAbilityForPrompt(player, slot, playerRanks[slot]),
    ).join(", ");
    const enemyLine = IMPORTANT_SLOTS.map((slot) =>
      describeAbilityForPrompt(enemy, slot, enemyRanks[slot]),
    ).join(", ");

    return [
      `Your champion (${player.champion}) at level ${level}: ${playerLine}.`,
      `Enemy champion (${enemy.champion}) at level ${level}: ${enemyLine}.`,
      `Trade window: ${trade.bestTradeWindow}`,
      `All-in read: ${trade.allInWinner}`,
      `Danger ability: ${trade.dangerAbility}`,
    ].join(" ");
  }
}

export const abilityDataService = new AbilityDataService();
