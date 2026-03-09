import "./load-env";

import { ProDataImporter } from "../src/lib/pro-data-importer";

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const entry = process.argv.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : undefined;
}

function toYear(value: string | undefined): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 2020 && parsed <= 2100) {
    return parsed;
  }
  return new Date().getFullYear();
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  const importer = new ProDataImporter();
  const year = toYear(getArg("year"));

  console.log(`[pro-import] Downloading Oracle CSV for ${year}...`);
  const csv = await importer.downloadCSV(year);
  console.log(`[pro-import] Parsing + importing...`);
  const report = await importer.parseAndImport(csv);
  console.log("[pro-import] Import report:", report);

  console.log("[pro-import] Computing team stats...");
  await importer.computeTeamStats();
  console.log("[pro-import] Done.");
}

main().catch((error) => {
  console.error("[pro-import] Failed:", error);
  process.exit(1);
});

