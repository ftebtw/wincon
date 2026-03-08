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

const AP_ASSASSINS = new Set([
  "Akali",
  "Diana",
  "Ekko",
  "Evelynn",
  "Fizz",
  "Kassadin",
  "Katarina",
]);

const AP_TANKS = new Set([
  "Amumu",
  "Cho'Gath",
  "Dr. Mundo",
  "Gragas",
  "Maokai",
  "Rammus",
  "Sejuani",
  "Zac",
]);

const AP_SUPPORTS = new Set([
  "Karma",
  "Lulu",
  "Milio",
  "Nami",
  "Renata Glasc",
  "Seraphine",
  "Sona",
  "Soraka",
  "Yuumi",
  "Zilean",
]);

const AD_SUPPORTS = new Set(["Pyke", "Senna"]);

const HEALING_HEAVY_CHAMPIONS = new Set([
  "Soraka",
  "Yuumi",
  "Sona",
  "Aatrox",
  "Dr. Mundo",
  "Vladimir",
  "Sylas",
  "Warwick",
  "Fiddlesticks",
  "Swain",
  "Maokai",
]);

const POKE_INDICATORS = new Set([
  "Xerath",
  "Lux",
  "Jayce",
  "Varus",
  "Nidalee",
  "Ziggs",
  "Zoe",
  "Vel'Koz",
]);

const ENGAGE_INDICATORS = new Set([
  "Malphite",
  "Leona",
  "Nautilus",
  "Amumu",
  "Ornn",
  "Sejuani",
  "Rakan",
]);

const SPLIT_PUSH_INDICATORS = new Set([
  "Fiora",
  "Tryndamere",
  "Jax",
  "Camille",
  "Yorick",
  "Nasus",
]);

const PEEL_INDICATORS = new Set([
  "Lulu",
  "Janna",
  "Braum",
  "Thresh",
  "Karma",
  "Renata Glasc",
]);

const SCALING_INDICATORS = new Set([
  "Kayle",
  "Kassadin",
  "Jinx",
  "Vayne",
  "Kog'Maw",
  "Veigar",
  "Senna",
]);

const EARLY_GAME_INDICATORS = new Set([
  "Lee Sin",
  "Elise",
  "Renekton",
  "Pantheon",
  "Draven",
  "Lucian",
  "Rek'Sai",
  "Nidalee",
]);

const CC_HEAVY_INDICATORS = new Set([
  "Amumu",
  "Leona",
  "Nautilus",
  "Sejuani",
  "Rell",
  "Maokai",
  "Lissandra",
  "Ornn",
]);

function normalizeChampionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function setHasChampion(set: Set<string>, championName: string): boolean {
  const normalizedChampion = normalizeChampionName(championName);
  for (const candidate of set) {
    if (normalizeChampionName(candidate) === normalizedChampion) {
      return true;
    }
  }

  return false;
}

function countChampionsInSet(championNames: string[], set: Set<string>): number {
  return championNames.reduce((count, championName) => {
    return count + Number(setHasChampion(set, championName));
  }, 0);
}

function inferDamageType(
  championName: string,
  championTags: string[],
): "AP" | "AD" | "Mixed" {
  if (setHasChampion(AP_ASSASSINS, championName)) {
    return "AP";
  }

  if (setHasChampion(AP_TANKS, championName)) {
    return "AP";
  }

  if (setHasChampion(AP_SUPPORTS, championName)) {
    return "AP";
  }

  if (setHasChampion(AD_SUPPORTS, championName)) {
    return "AD";
  }

  if (championTags.includes("Mage")) {
    return "AP";
  }

  if (championTags.includes("Marksman")) {
    return "AD";
  }

  if (championTags.includes("Assassin")) {
    return "AD";
  }

  if (championTags.includes("Fighter")) {
    return "AD";
  }

  if (championTags.includes("Tank")) {
    return "Mixed";
  }

  if (championTags.includes("Support")) {
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

export async function classifyTeamComp(
  championNames: string[],
): Promise<CompAnalysis> {
  const uniqueChampionNames = championNames.filter(Boolean);
  const championDetails = await Promise.all(
    uniqueChampionNames.map(async (championName) => {
      const champion = await getChampionByName(championName);
      return {
        championName,
        tags: champion?.tags ?? [],
      };
    }),
  );

  let apDealers = 0;
  let adDealers = 0;
  let assassinCount = 0;
  let tankCount = 0;
  let bruiserCount = 0;
  let supportCount = 0;

  for (const champion of championDetails) {
    if (champion.tags.includes("Assassin")) {
      assassinCount += 1;
    }

    if (champion.tags.includes("Tank")) {
      tankCount += 1;
    }

    if (champion.tags.includes("Fighter")) {
      bruiserCount += 1;
    }

    if (champion.tags.includes("Support")) {
      supportCount += 1;
    }

    const damageType = inferDamageType(champion.championName, champion.tags);

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
    primaryDamageType = "Mixed";
  }

  if (assassinCount >= 2) {
    tags.add("assassin_heavy");
  }

  if (tankCount >= 2) {
    tags.add("tank_heavy");
  }

  if (bruiserCount >= 3) {
    tags.add("bruiser_heavy");
  }

  const pokeCount = countChampionsInSet(uniqueChampionNames, POKE_INDICATORS);
  const engageCount = countChampionsInSet(uniqueChampionNames, ENGAGE_INDICATORS);
  const splitPushCount = countChampionsInSet(
    uniqueChampionNames,
    SPLIT_PUSH_INDICATORS,
  );
  const scalingCount = countChampionsInSet(uniqueChampionNames, SCALING_INDICATORS);
  const earlyGameCount = countChampionsInSet(
    uniqueChampionNames,
    EARLY_GAME_INDICATORS,
  );
  const healingCount = countChampionsInSet(
    uniqueChampionNames,
    HEALING_HEAVY_CHAMPIONS,
  );
  const peelCount = countChampionsInSet(uniqueChampionNames, PEEL_INDICATORS);
  const ccCount = countChampionsInSet(uniqueChampionNames, CC_HEAVY_INDICATORS);

  if (pokeCount >= 2) {
    tags.add("poke_comp");
  }

  if (engageCount >= 2 || (engageCount >= 1 && tankCount >= 2)) {
    tags.add("engage_comp");
  }

  if (splitPushCount >= 1) {
    tags.add("split_push");
  }

  if (scalingCount >= 2) {
    tags.add("scaling_comp");
  }

  if (earlyGameCount >= 2) {
    tags.add("early_game");
  }

  if (healingCount >= 1) {
    tags.add("healing_heavy");
  }

  if (ccCount >= 2 || tankCount + supportCount >= 3) {
    tags.add("cc_heavy");
  }

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

// Compatibility helper used in early scaffolding.
export async function classifyTeamCompositions(
  match: RiotMatch,
): Promise<TeamCompClassification[]> {
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
