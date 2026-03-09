import championTagsFile from "@/data/champion-tags.json";
import { getChampionByName } from "@/lib/data-dragon";
import type { RiotMatch } from "@/lib/types/riot";

export type CompTag =
  | "high_ap"
  | "high_ad"
  | "mixed_damage"
  | "assassin_heavy"
  | "tank_heavy"
  | "bruiser_heavy"
  | "poke_comp"
  | "engage_comp"
  | "split_push"
  | "scaling_comp"
  | "early_game"
  | "healing_heavy"
  | "cc_heavy"
  | "peel_heavy"
  | "dive_comp";

export interface CompAnalysis {
  tags: CompTag[];
  primaryDamageType: "AP" | "AD" | "Mixed";
  teamIdentity: string;
}

export interface DualCompAnalysis {
  ally: CompAnalysis;
  enemy: CompAnalysis;
}

export interface TeamCompClassification {
  teamId: number;
  tags: CompTag[];
}

type ChampionTagsFile = {
  lastVerifiedPatch: string;
  generatedAt: string;
  champions: Record<string, string[]>;
};

const championTags = championTagsFile as ChampionTagsFile;
const warnedUnknownChampions = new Set<string>();

function normalizeChampionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeTag(tag: string): string {
  return tag.toLowerCase().replace(/\s+/g, "_");
}

function parsePatchVersion(patch: string): { major: number; minor: number } | null {
  const [majorRaw, minorRaw] = patch.split(".");
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return null;
  }
  return { major, minor };
}

export function getChampionTagDatasetStatus(currentPatch: string): {
  lastVerifiedPatch: string;
  staleByPatches: number | null;
  isStale: boolean;
  warning: string | null;
} {
  const lastVerifiedPatch = championTags.lastVerifiedPatch ?? "unknown";
  const current = parsePatchVersion(currentPatch);
  const last = parsePatchVersion(lastVerifiedPatch);

  if (!current || !last) {
    return {
      lastVerifiedPatch,
      staleByPatches: null,
      isStale: true,
      warning:
        "Champion tag dataset patch version is unknown. Regenerate champion-tags.json.",
    };
  }

  const staleByPatches = Math.max(0, current.minor - last.minor);
  const isStale = current.major !== last.major || staleByPatches > 1;
  return {
    lastVerifiedPatch,
    staleByPatches,
    isStale,
    warning: isStale
      ? `Champion tag dataset is ${staleByPatches} patch(es) behind (${lastVerifiedPatch} vs ${currentPatch}).`
      : null,
  };
}

function getCustomChampionTags(championName: string): string[] {
  const normalizedName = normalizeChampionName(championName);
  for (const [name, tags] of Object.entries(championTags.champions ?? {})) {
    if (normalizeChampionName(name) === normalizedName) {
      return tags.map(normalizeTag);
    }
  }
  return [];
}

async function resolveChampionTags(championName: string): Promise<string[]> {
  const custom = getCustomChampionTags(championName);
  const champion = await getChampionByName(championName);
  const base = champion?.tags?.map(normalizeTag) ?? [];
  const merged = Array.from(new Set([...base, ...custom]));

  if (merged.length === 0 && !warnedUnknownChampions.has(championName)) {
    warnedUnknownChampions.add(championName);
    console.warn(
      `[CompClassifier] Unknown champion encountered: ${championName}. Falling back to empty tag set.`,
    );
  }

  return merged;
}

function hasChampionTag(tags: string[], target: string): boolean {
  return tags.includes(target);
}

function inferDamageType(tags: string[]): "AP" | "AD" | "Mixed" {
  if (hasChampionTag(tags, "ap_damage")) {
    return "AP";
  }
  if (hasChampionTag(tags, "ad_damage")) {
    return "AD";
  }
  if (hasChampionTag(tags, "mage")) {
    return "AP";
  }
  if (hasChampionTag(tags, "marksman")) {
    return "AD";
  }
  if (hasChampionTag(tags, "assassin")) {
    return "AD";
  }
  if (hasChampionTag(tags, "fighter")) {
    return "AD";
  }
  if (hasChampionTag(tags, "support")) {
    return "AP";
  }
  return "Mixed";
}

function buildTeamIdentity(tags: Set<CompTag>, primaryDamageType: "AP" | "AD" | "Mixed") {
  let strategy = "balanced teamfight comp";

  if (tags.has("engage_comp")) {
    strategy = "engage teamfight comp";
  } else if (tags.has("poke_comp")) {
    strategy = "poke siege comp";
  } else if (tags.has("split_push")) {
    strategy = "split push comp";
  } else if (tags.has("scaling_comp")) {
    strategy = "late-game scaling comp";
  } else if (tags.has("early_game")) {
    strategy = "early skirmish comp";
  }

  const damageDescriptor =
    primaryDamageType === "AP"
      ? "high AP damage"
      : primaryDamageType === "AD"
        ? "high AD damage"
        : "mixed damage";

  return `${strategy} with ${damageDescriptor}`;
}

export async function classifyTeamComp(championNames: string[]): Promise<CompAnalysis> {
  const uniqueChampionNames = championNames.filter(Boolean);
  const championDetails = await Promise.all(
    uniqueChampionNames.map(async (championName) => ({
      championName,
      tags: await resolveChampionTags(championName),
    })),
  );

  let apDealers = 0;
  let adDealers = 0;
  let assassinCount = 0;
  let tankCount = 0;
  let bruiserCount = 0;
  let supportCount = 0;
  let pokeCount = 0;
  let engageCount = 0;
  let splitPushCount = 0;
  let scalingCount = 0;
  let earlyGameCount = 0;
  let healingCount = 0;
  let peelCount = 0;
  let ccCount = 0;

  for (const champion of championDetails) {
    if (hasChampionTag(champion.tags, "assassin")) assassinCount += 1;
    if (hasChampionTag(champion.tags, "tank")) tankCount += 1;
    if (hasChampionTag(champion.tags, "fighter")) bruiserCount += 1;
    if (hasChampionTag(champion.tags, "support")) supportCount += 1;

    if (hasChampionTag(champion.tags, "poke")) pokeCount += 1;
    if (hasChampionTag(champion.tags, "engage")) engageCount += 1;
    if (hasChampionTag(champion.tags, "split_push")) splitPushCount += 1;
    if (hasChampionTag(champion.tags, "scaling")) scalingCount += 1;
    if (hasChampionTag(champion.tags, "early_game")) earlyGameCount += 1;
    if (
      hasChampionTag(champion.tags, "healing") ||
      hasChampionTag(champion.tags, "drain_tank")
    ) {
      healingCount += 1;
    }
    if (hasChampionTag(champion.tags, "peel") || hasChampionTag(champion.tags, "enchanter")) {
      peelCount += 1;
    }
    if (hasChampionTag(champion.tags, "cc")) ccCount += 1;

    const damageType = inferDamageType(champion.tags);
    if (damageType === "AP") {
      apDealers += 1;
    } else if (damageType === "AD") {
      adDealers += 1;
    } else {
      apDealers += 0.5;
      adDealers += 0.5;
    }
  }

  const tags = new Set<CompTag>();
  let primaryDamageType: "AP" | "AD" | "Mixed" = "Mixed";

  if (apDealers >= 3) {
    tags.add("high_ap");
    primaryDamageType = "AP";
  } else if (adDealers >= 3) {
    tags.add("high_ad");
    primaryDamageType = "AD";
  } else {
    tags.add("mixed_damage");
  }

  if (assassinCount >= 2) tags.add("assassin_heavy");
  if (tankCount >= 2) tags.add("tank_heavy");
  if (bruiserCount >= 3) tags.add("bruiser_heavy");
  if (pokeCount >= 2) tags.add("poke_comp");
  if (engageCount >= 2 || (engageCount >= 1 && tankCount >= 2)) tags.add("engage_comp");
  if (splitPushCount >= 1) tags.add("split_push");
  if (scalingCount >= 2) tags.add("scaling_comp");
  if (earlyGameCount >= 2) tags.add("early_game");
  if (healingCount >= 1) tags.add("healing_heavy");
  if (ccCount >= 2 || tankCount + supportCount >= 3) tags.add("cc_heavy");
  if (peelCount >= 1 || (supportCount >= 2 && !tags.has("engage_comp"))) {
    tags.add("peel_heavy");
  }
  if (
    (tags.has("engage_comp") && (assassinCount >= 1 || bruiserCount >= 2)) ||
    (assassinCount >= 2 && engageCount >= 1)
  ) {
    tags.add("dive_comp");
  }

  return {
    tags: Array.from(tags),
    primaryDamageType,
    teamIdentity: buildTeamIdentity(tags, primaryDamageType),
  };
}

export async function classifyBothComps(
  allyChampions: string[],
  enemyChampions: string[],
): Promise<DualCompAnalysis> {
  const [ally, enemy] = await Promise.all([
    classifyTeamComp(allyChampions),
    classifyTeamComp(enemyChampions),
  ]);
  return { ally, enemy };
}

function isCarryRole(role: string): boolean {
  const normalized = role.toLowerCase();
  return ["adc", "bottom", "mid", "middle", "carry"].includes(normalized);
}

export function getCompBasedBuildAdvice(
  champion: string,
  role: string,
  allyTags: CompTag[],
  enemyTags: CompTag[],
): string[] {
  const advice = new Set<string>();
  const carry = isCarryRole(role);
  const roleUpper = role.toUpperCase();

  if (enemyTags.includes("healing_heavy")) {
    advice.add("Build Grievous Wounds (Morellonomicon, Thornmail, etc.).");
  }
  if (enemyTags.includes("high_ap")) {
    advice.add("Prioritize Magic Resist items earlier.");
  }
  if (enemyTags.includes("high_ad")) {
    advice.add("Prioritize armor and anti-physical burst options.");
  }
  if (enemyTags.includes("assassin_heavy") && carry) {
    advice.add("Consider Guardian Angel or Zhonya's to survive burst.");
  }
  if (enemyTags.includes("cc_heavy")) {
    advice.add("Take tenacity options (Mercury's Treads, Cleanse, or QSS path).");
  }
  if (enemyTags.includes("poke_comp")) {
    advice.add("Value sustain and reliable engage tools against long-range poke.");
  }
  if (enemyTags.includes("dive_comp") && carry) {
    advice.add("Buy defensive positioning tools and hold cooldowns for self-peel.");
  }
  if (allyTags.includes("engage_comp") && carry) {
    advice.add("Build more damage - your team provides reliable engage and setup.");
  }
  if (!allyTags.includes("peel_heavy") && carry) {
    advice.add("Consider defensive boots and self-peel items due to low team peel.");
  }
  if (allyTags.includes("peel_heavy") && carry) {
    advice.add("You can greed more DPS since your team has strong peel.");
  }
  if (allyTags.includes("split_push") && roleUpper === "TOP") {
    advice.add("Favor side-lane dueling and tower pressure itemization.");
  }
  if (allyTags.includes("scaling_comp")) {
    advice.add("Itemize for consistent late-game fights and avoid early coin flips.");
  }
  if (advice.size === 0) {
    advice.add(`Build around ${champion}'s core spikes and adapt to live threats.`);
  }

  return Array.from(advice);
}

export async function classifyTeamCompositions(match: RiotMatch): Promise<TeamCompClassification[]> {
  const groupedByTeam = match.info.participants.reduce<Record<number, string[]>>(
    (acc, participant) => {
      if (!acc[participant.teamId]) {
        acc[participant.teamId] = [];
      }
      acc[participant.teamId].push(participant.championName);
      return acc;
    },
    {},
  );

  const entries = Object.entries(groupedByTeam);
  const analyses = await Promise.all(
    entries.map(async ([teamId, champions]) => {
      const analysis = await classifyTeamComp(champions);
      return {
        teamId: Number(teamId),
        tags: analysis.tags,
      };
    }),
  );

  return analyses;
}
