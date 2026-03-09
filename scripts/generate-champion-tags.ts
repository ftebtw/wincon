import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUTPUT_FILE = path.resolve(process.cwd(), "src/data/champion-tags.json");

const TAG_GROUPS: Record<string, string[]> = {
  healing: [
    "Soraka",
    "Yuumi",
    "Sona",
    "Aatrox",
    "DrMundo",
    "Vladimir",
    "Sylas",
    "Warwick",
    "Fiddlesticks",
    "Swain",
    "Maokai",
    "Briar",
    "Rhaast",
  ],
  drain_tank: ["Aatrox", "Vladimir", "Swain", "Rhaast", "Warwick"],
  poke: ["Xerath", "Lux", "Jayce", "Varus", "Nidalee", "Ziggs", "Zoe", "Velkoz"],
  engage: ["Malphite", "Leona", "Nautilus", "Amumu", "Ornn", "Sejuani", "Rakan", "Rell"],
  split_push: ["Fiora", "Tryndamere", "Jax", "Camille", "Yorick", "Nasus", "Gwen"],
  peel: ["Lulu", "Janna", "Braum", "Thresh", "Karma", "Renata", "Milio", "Nami", "Sona"],
  scaling: ["Kayle", "Kassadin", "Jinx", "Vayne", "KogMaw", "Veigar", "Senna", "Smolder"],
  early_game: ["LeeSin", "Elise", "Renekton", "Pantheon", "Draven", "Lucian", "RekSai", "Nidalee"],
  cc: ["Amumu", "Leona", "Nautilus", "Sejuani", "Rell", "Maokai", "Lissandra", "Ornn", "Ashe", "Morgana"],
  enchanter: ["Lulu", "Janna", "Karma", "Milio", "Soraka", "Nami", "Sona", "Yuumi", "Renata", "Seraphine"],
  ap_damage: [
    "Akali",
    "Diana",
    "Ekko",
    "Evelynn",
    "Fizz",
    "Kassadin",
    "Katarina",
    "Amumu",
    "ChoGath",
    "Gragas",
    "Maokai",
    "Rammus",
    "Sejuani",
    "Zac",
    "Karma",
    "Lulu",
    "Milio",
    "Nami",
    "Renata",
    "Seraphine",
    "Sona",
    "Soraka",
    "Yuumi",
    "Zilean",
  ],
  ad_damage: ["Pyke", "Senna", "Talon", "Qiyana", "KhaZix", "Rengar", "Naafiri", "Zed"],
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function addTag(
  championTags: Map<string, Set<string>>,
  championName: string,
  tag: string,
): void {
  const existing = championTags.get(championName) ?? new Set<string>();
  existing.add(tag);
  championTags.set(championName, existing);
}

async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(
    "https://ddragon.leagueoflegends.com/api/versions.json",
    {
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch Data Dragon versions: ${response.status}`);
  }
  const versions = (await response.json()) as string[];
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error("No Data Dragon versions returned.");
  }
  return versions[0];
}

type DataDragonChampion = {
  id: string;
  name: string;
  tags?: string[];
};

async function fetchChampionData(version: string): Promise<Record<string, DataDragonChampion>> {
  const response = await fetch(
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`,
    {
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch champion data: ${response.status}`);
  }
  const payload = (await response.json()) as {
    data: Record<string, DataDragonChampion>;
  };
  return payload.data;
}

async function main() {
  const version = await fetchLatestVersion();
  const champions = await fetchChampionData(version);
  const championTags = new Map<string, Set<string>>();

  for (const champion of Object.values(champions)) {
    const normalizedBaseTags = (champion.tags ?? []).map((tag) =>
      tag.toLowerCase().replace(/\s+/g, "_"),
    );
    championTags.set(champion.name, new Set(normalizedBaseTags));

    if (normalizedBaseTags.includes("mage") || normalizedBaseTags.includes("support")) {
      addTag(championTags, champion.name, "ap_damage");
    }
    if (
      normalizedBaseTags.includes("marksman") ||
      normalizedBaseTags.includes("assassin") ||
      normalizedBaseTags.includes("fighter")
    ) {
      addTag(championTags, champion.name, "ad_damage");
    }
  }

  const championLookup = new Map<string, string>();
  for (const champion of Object.values(champions)) {
    championLookup.set(normalize(champion.id), champion.name);
    championLookup.set(normalize(champion.name), champion.name);
  }

  const unknownNames: string[] = [];
  for (const [tag, names] of Object.entries(TAG_GROUPS)) {
    for (const rawName of names) {
      const resolved = championLookup.get(normalize(rawName));
      if (!resolved) {
        unknownNames.push(rawName);
        continue;
      }
      addTag(championTags, resolved, tag);
    }
  }

  const finalOutput = {
    lastVerifiedPatch: version.split(".").slice(0, 2).join("."),
    generatedAt: new Date().toISOString(),
    champions: Object.fromEntries(
      [...championTags.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, tags]) => [name, [...tags].sort()]),
    ),
  };

  await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(finalOutput, null, 2)}\n`, "utf-8");

  console.log(
    `Generated champion tags for ${Object.keys(finalOutput.champions).length} champions at patch ${finalOutput.lastVerifiedPatch}.`,
  );

  if (unknownNames.length > 0) {
    console.warn(
      `Manual review needed for unresolved tag overrides: ${unknownNames.join(", ")}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
