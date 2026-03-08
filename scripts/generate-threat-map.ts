import "dotenv/config";

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getChampions } from "../src/lib/data-dragon";

type DraftThreatMap = {
  generatedAt: string;
  notes: string[];
  autoClassifications: {
    burst_assassin: string[];
    tank_stacking_candidates: string[];
    heavy_healing_candidates: string[];
    heavy_cc_candidates: string[];
    peel_candidates: string[];
    likely_ap_damage: string[];
    likely_ad_damage: string[];
  };
  missingManualReview: string[];
};

function normalizeChampionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MANUAL_OVERRIDES = new Set([
  "kayns",
  "kayn",
  "nidalee",
  "elise",
  "udyr",
  "gragas",
  "volibear",
  "blitzcrank",
  "renataglasc",
]);

async function main() {
  const champions = await getChampions();
  const values = [...champions.values()];

  const burstAssassin = values
    .filter(
      (champion) =>
        champion.tags.includes("Assassin") || champion.tags.includes("Slayer"),
    )
    .map((champion) => champion.name);
  const tankCandidates = values
    .filter((champion) => champion.tags.includes("Tank"))
    .map((champion) => champion.name);
  const peelCandidates = values
    .filter((champion) => champion.tags.includes("Support"))
    .map((champion) => champion.name);
  const likelyAp = values
    .filter(
      (champion) =>
        champion.tags.includes("Mage") ||
        (champion.tags.includes("Support") && !champion.tags.includes("Marksman")),
    )
    .map((champion) => champion.name);
  const likelyAd = values
    .filter(
      (champion) =>
        champion.tags.includes("Marksman") ||
        champion.tags.includes("Fighter") ||
        champion.tags.includes("Assassin"),
    )
    .map((champion) => champion.name);

  const heavyCcCandidates = values
    .filter((champion) => {
      const tags = champion.tags.map((tag) => tag.toLowerCase());
      return tags.includes("tank") || tags.includes("support") || tags.includes("mage");
    })
    .map((champion) => champion.name);

  const heavyHealingCandidates = values
    .filter((champion) => {
      const normalized = normalizeChampionName(champion.name);
      return [
        "aatrox",
        "soraka",
        "yuumi",
        "warwick",
        "vladimir",
        "fiddlesticks",
        "swain",
        "sylas",
        "mundo",
        "briar",
      ].some((target) => normalized.includes(target));
    })
    .map((champion) => champion.name);

  const missingManualReview = values
    .map((champion) => champion.name)
    .filter((name) => MANUAL_OVERRIDES.has(normalizeChampionName(name)))
    .sort((a, b) => a.localeCompare(b));

  const output: DraftThreatMap = {
    generatedAt: new Date().toISOString(),
    notes: [
      "This draft is auto-generated from champion tags and simple heuristics.",
      "Review edge cases manually (form-swappers, hybrid champs, reworks).",
      "Copy confirmed entries into src/data/item-threat-map.json.",
    ],
    autoClassifications: {
      burst_assassin: burstAssassin.sort((a, b) => a.localeCompare(b)),
      tank_stacking_candidates: tankCandidates.sort((a, b) => a.localeCompare(b)),
      heavy_healing_candidates: heavyHealingCandidates.sort((a, b) => a.localeCompare(b)),
      heavy_cc_candidates: heavyCcCandidates.sort((a, b) => a.localeCompare(b)),
      peel_candidates: peelCandidates.sort((a, b) => a.localeCompare(b)),
      likely_ap_damage: likelyAp.sort((a, b) => a.localeCompare(b)),
      likely_ad_damage: likelyAd.sort((a, b) => a.localeCompare(b)),
    },
    missingManualReview,
  };

  const targetPath = resolve(process.cwd(), "scripts", "generated-threat-map.json");
  writeFileSync(targetPath, JSON.stringify(output, null, 2), "utf-8");

  console.log(`Generated threat map draft at: ${targetPath}`);
  console.log(
    `Auto candidates: assassins=${output.autoClassifications.burst_assassin.length}, tanks=${output.autoClassifications.tank_stacking_candidates.length}, healers=${output.autoClassifications.heavy_healing_candidates.length}`,
  );
}

main().catch((error) => {
  console.error("[generate-threat-map] failed:", error);
  process.exit(1);
});
