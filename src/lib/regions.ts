export type Region =
  | "NA"
  | "EUW"
  | "EUNE"
  | "KR"
  | "JP"
  | "BR"
  | "LAN"
  | "LAS"
  | "OCE"
  | "TR"
  | "RU"
  | "PH"
  | "SG"
  | "TH"
  | "TW"
  | "VN";

export const REGION_COOKIE_NAME = "wincon_region";

export const REGION_CONFIG: Record<
  Region,
  { platform: string; regional: string; displayName: string }
> = {
  NA: { platform: "na1", regional: "americas", displayName: "North America" },
  EUW: { platform: "euw1", regional: "europe", displayName: "Europe West" },
  EUNE: {
    platform: "eun1",
    regional: "europe",
    displayName: "Europe Nordic & East",
  },
  KR: { platform: "kr", regional: "asia", displayName: "Korea" },
  JP: { platform: "jp1", regional: "asia", displayName: "Japan" },
  BR: { platform: "br1", regional: "americas", displayName: "Brazil" },
  LAN: {
    platform: "la1",
    regional: "americas",
    displayName: "Latin America North",
  },
  LAS: {
    platform: "la2",
    regional: "americas",
    displayName: "Latin America South",
  },
  OCE: { platform: "oc1", regional: "sea", displayName: "Oceania" },
  TR: { platform: "tr1", regional: "europe", displayName: "Turkey" },
  RU: { platform: "ru", regional: "europe", displayName: "Russia" },
  PH: { platform: "ph2", regional: "sea", displayName: "Philippines" },
  SG: { platform: "sg2", regional: "sea", displayName: "Singapore" },
  TH: { platform: "th2", regional: "sea", displayName: "Thailand" },
  TW: { platform: "tw2", regional: "sea", displayName: "Taiwan" },
  VN: { platform: "vn2", regional: "sea", displayName: "Vietnam" },
};

export const REGION_ORDER: Region[] = [
  "NA",
  "EUW",
  "EUNE",
  "KR",
  "JP",
  "BR",
  "LAN",
  "LAS",
  "OCE",
  "TR",
  "RU",
  "PH",
  "SG",
  "TH",
  "TW",
  "VN",
];

const PLATFORM_TO_REGION: Record<string, Region> = Object.entries(REGION_CONFIG).reduce(
  (acc, [region, config]) => {
    acc[config.platform] = region as Region;
    return acc;
  },
  {} as Record<string, Region>,
);

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    ordered.push(value);
  }

  return ordered;
}

export function parseRegion(value?: string | null): Region | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized in REGION_CONFIG) {
    return normalized as Region;
  }

  return undefined;
}

export function getRegionConfig(region: Region) {
  return REGION_CONFIG[region];
}

export function getRegionFromPlatform(platform?: string | null): Region | undefined {
  if (!platform) {
    return undefined;
  }
  return PLATFORM_TO_REGION[platform.trim().toLowerCase()];
}

export function inferPlatformFromTagLine(tagLine: string): string | undefined {
  const normalized = tagLine.trim().toLowerCase();
  if (normalized in PLATFORM_TO_REGION) {
    return normalized;
  }
  return undefined;
}

export function inferRegionFromTagLine(tagLine: string): Region | undefined {
  return getRegionFromPlatform(inferPlatformFromTagLine(tagLine));
}

function parseCookie(header: string, targetKey: string): string | undefined {
  const chunks = header.split(";");
  for (const chunk of chunks) {
    const [key, ...rest] = chunk.trim().split("=");
    if (key !== targetKey) {
      continue;
    }
    return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function getRegionFromRequest(request: Request, fallback: Region = "NA"): Region {
  const url = new URL(request.url);
  const queryRegion = parseRegion(url.searchParams.get("region"));
  if (queryRegion) {
    return queryRegion;
  }

  const cookieRegion = parseRegion(
    parseCookie(request.headers.get("cookie") ?? "", REGION_COOKIE_NAME),
  );
  if (cookieRegion) {
    return cookieRegion;
  }

  return fallback;
}

export function buildRegionalCandidates(params: {
  preferredRegion?: Region;
  inferredRegional?: string;
}): string[] {
  const ordered = [
    params.preferredRegion ? getRegionConfig(params.preferredRegion).regional : undefined,
    params.inferredRegional,
    "americas",
    "europe",
    "asia",
    "sea",
  ].filter((entry): entry is string => Boolean(entry));

  return dedupe(ordered);
}

export function buildPlatformCandidates(params: {
  preferredRegion?: Region;
  inferredPlatform?: string;
}): string[] {
  const preferredPlatform = params.preferredRegion
    ? getRegionConfig(params.preferredRegion).platform
    : undefined;

  const ordered = [
    preferredPlatform,
    params.inferredPlatform,
    ...REGION_ORDER.map((region) => getRegionConfig(region).platform),
  ].filter((entry): entry is string => Boolean(entry));

  return dedupe(ordered);
}
