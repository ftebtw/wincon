import "dotenv/config";

import { eq } from "drizzle-orm";

import { getChampionByName, getLatestVersion } from "../src/lib/data-dragon";
import { db, pool, schema } from "../src/lib/db";

type Role = "TOP" | "JUNGLE" | "MID" | "ADC" | "SUPPORT";

type SeedEntry = {
  championName: string;
  role: Role;
  itemBuildPath: number[];
  winRate: number;
  sampleSize: number;
};

const TOP_CHAMPIONS = [
  "Aatrox",
  "Darius",
  "Fiora",
  "Garen",
  "Camille",
  "Jax",
  "Ornn",
  "Renekton",
  "Sett",
  "Mordekaiser",
  "Nasus",
  "Tryndamere",
  "Riven",
  "Irelia",
  "Yorick",
  "Malphite",
  "Gwen",
  "Shen",
  "Volibear",
  "Illaoi",
];

const JUNGLE_CHAMPIONS = [
  "Lee Sin",
  "Viego",
  "Sejuani",
  "Wukong",
  "Jarvan IV",
  "Kayn",
  "Bel'Veth",
  "Kha'Zix",
  "Graves",
  "Nocturne",
  "Vi",
  "Xin Zhao",
  "Diana",
  "Evelynn",
  "Lillia",
  "Maokai",
  "Rammus",
  "Amumu",
  "Nunu & Willump",
  "Ekko",
];

const MID_CHAMPIONS = [
  "Ahri",
  "Orianna",
  "Syndra",
  "Azir",
  "Viktor",
  "Akali",
  "Yasuo",
  "Yone",
  "Zed",
  "LeBlanc",
  "Taliyah",
  "Annie",
  "Katarina",
  "Kassadin",
  "Twisted Fate",
  "Veigar",
  "Xerath",
  "Lux",
  "Vex",
  "Sylas",
];

const ADC_CHAMPIONS = [
  "Jinx",
  "Kai'Sa",
  "Caitlyn",
  "Ezreal",
  "Varus",
  "Ashe",
  "Lucian",
  "Miss Fortune",
  "Vayne",
  "Kog'Maw",
  "Draven",
  "Zeri",
  "Aphelios",
  "Xayah",
  "Sivir",
  "Tristana",
  "Samira",
  "Twitch",
  "Nilah",
  "Kalista",
];

const SUPPORT_CHAMPIONS = [
  "Lulu",
  "Nautilus",
  "Leona",
  "Thresh",
  "Rakan",
  "Janna",
  "Milio",
  "Renata Glasc",
  "Karma",
  "Soraka",
  "Nami",
  "Braum",
  "Pyke",
  "Blitzcrank",
  "Alistar",
  "Sona",
  "Yuumi",
  "Taric",
  "Rell",
  "Zyra",
];

const AP_CHAMPIONS = new Set([
  "Mordekaiser",
  "Gwen",
  "Diana",
  "Evelynn",
  "Lillia",
  "Ekko",
  "Ahri",
  "Orianna",
  "Syndra",
  "Azir",
  "Viktor",
  "Akali",
  "LeBlanc",
  "Taliyah",
  "Annie",
  "Kassadin",
  "Veigar",
  "Xerath",
  "Lux",
  "Vex",
  "Sylas",
  "Lulu",
  "Janna",
  "Milio",
  "Renata Glasc",
  "Karma",
  "Soraka",
  "Nami",
  "Sona",
  "Yuumi",
  "Taric",
  "Zyra",
]);

const TANK_CHAMPIONS = new Set([
  "Ornn",
  "Malphite",
  "Shen",
  "Sejuani",
  "Maokai",
  "Rammus",
  "Amumu",
  "Nautilus",
  "Leona",
  "Braum",
  "Alistar",
  "Rell",
]);

function patchFromVersion(version: string): string {
  const [major, minor] = version.split(".");
  if (!major || !minor) {
    return version;
  }

  return `${major}.${minor}`;
}

function roleBaseBuild(role: Role, championName: string): number[] {
  const isTank = TANK_CHAMPIONS.has(championName);
  const isAp = AP_CHAMPIONS.has(championName);

  if (role === "TOP") {
    if (isTank) {
      return [3068, 3111, 3075, 3143, 4401, 3742];
    }
    if (isAp) {
      return [3157, 3111, 4633, 3135, 3089, 3102];
    }
    return [3071, 3047, 6630, 3026, 6333, 3074];
  }

  if (role === "JUNGLE") {
    if (isTank) {
      return [3068, 3047, 3075, 3111, 4401, 3143];
    }
    if (isAp) {
      return [3111, 3157, 4633, 3135, 3089, 3102];
    }
    return [3111, 6630, 3071, 3026, 6333, 6694];
  }

  if (role === "MID") {
    if (isAp) {
      return [3020, 6655, 3157, 3135, 3089, 3102];
    }
    return [3158, 6692, 3157, 6694, 3026, 3814];
  }

  if (role === "ADC") {
    return [3006, 6672, 3031, 3094, 3036, 3026];
  }

  if (isTank) {
    return [3117, 3190, 3109, 3222, 3075, 2065];
  }

  if (isAp) {
    return [3158, 2065, 3109, 3504, 6617, 3916];
  }

  return [3117, 2065, 3109, 3190, 3222, 3860];
}

function generateSeedEntries(): SeedEntry[] {
  const byRole: Array<{ role: Role; champions: string[] }> = [
    { role: "TOP", champions: TOP_CHAMPIONS },
    { role: "JUNGLE", champions: JUNGLE_CHAMPIONS },
    { role: "MID", champions: MID_CHAMPIONS },
    { role: "ADC", champions: ADC_CHAMPIONS },
    { role: "SUPPORT", champions: SUPPORT_CHAMPIONS },
  ];

  const entries: SeedEntry[] = [];

  for (const group of byRole) {
    for (let index = 0; index < group.champions.length; index += 1) {
      const championName = group.champions[index];
      entries.push({
        championName,
        role: group.role,
        itemBuildPath: roleBaseBuild(group.role, championName),
        winRate: 0.5 + ((index % 8) * 0.006),
        sampleSize: 800 + index * 60,
      });
    }
  }

  return entries;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run seed-builds.");
  }

  const latestVersion = await getLatestVersion();
  const patch = patchFromVersion(latestVersion);
  const seedEntries = generateSeedEntries();

  const rows: Array<typeof schema.buildStats.$inferInsert> = [];

  for (const entry of seedEntries) {
    const champion = await getChampionByName(entry.championName);
    if (!champion) {
      console.warn(`[seed-builds] Champion not found in Data Dragon: ${entry.championName}`);
      continue;
    }

    rows.push({
      championId: Number(champion.key),
      role: entry.role,
      allyCompTags: [],
      enemyCompTags: [],
      itemBuildPath: entry.itemBuildPath,
      sampleSize: entry.sampleSize,
      winRate: entry.winRate.toFixed(4),
      avgGameLength: 1800,
      patch,
      computedAt: new Date(),
    });
  }

  await db.delete(schema.buildStats).where(eq(schema.buildStats.patch, patch));

  const chunkSize = 50;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    await db.insert(schema.buildStats).values(chunk);
  }

  console.log(`[seed-builds] Inserted ${rows.length} build baselines for patch ${patch}.`);
}

main()
  .catch((error) => {
    console.error("[seed-builds] Failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
