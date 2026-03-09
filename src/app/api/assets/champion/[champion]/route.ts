import { NextResponse } from "next/server";

import { cdragonService } from "@/lib/cdragon";
import { getChampionById, getChampionByName, getLatestVersion } from "@/lib/data-dragon";

type CacheEntry = {
  expiresAt: number;
  url: string;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const iconCache = new Map<string, CacheEntry>();

function normalizeChampionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildDdragonFallbackUrl(champion: string, version: string): string {
  const sanitizedId = champion.replace(/[^A-Za-z0-9]/g, "");
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${sanitizedId}.png`;
}

async function resolveChampionIconUrl(championParam: string): Promise<string> {
  const decoded = decodeURIComponent(championParam).trim();
  const cacheKey = normalizeChampionName(decoded || championParam);
  const cached = iconCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const parsedId = Number(decoded);
  if (Number.isFinite(parsedId) && parsedId > 0) {
    const championById = await getChampionById(parsedId).catch(() => undefined);
    if (championById) {
      iconCache.set(cacheKey, {
        url: championById.iconUrl,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return championById.iconUrl;
    }
  }

  const championByName = await getChampionByName(decoded).catch(() => undefined);
  if (championByName) {
    iconCache.set(cacheKey, {
      url: championByName.iconUrl,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return championByName.iconUrl;
  }

  const list = await cdragonService.getChampionList("latest").catch(() => []);
  const normalized = normalizeChampionName(decoded);
  const match = list.find(
    (entry) =>
      normalizeChampionName(entry.name) === normalized ||
      normalizeChampionName(entry.alias) === normalized ||
      String(entry.id) === decoded,
  );

  if (match) {
    const cdragonUrl = cdragonService.getAssetUrl(
      `/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${match.id}.png`,
      "latest",
    );
    iconCache.set(cacheKey, {
      url: cdragonUrl,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return cdragonUrl;
  }

  const version = await getLatestVersion().catch(
    () => process.env.NEXT_PUBLIC_DATA_DRAGON_VERSION ?? "16.5.1",
  );
  const fallback = buildDdragonFallbackUrl(decoded, version);
  iconCache.set(cacheKey, {
    url: fallback,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  return fallback;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ champion: string }> },
) {
  const { champion } = await params;
  const url = await resolveChampionIconUrl(champion);
  const response = NextResponse.redirect(url, { status: 307 });
  response.headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
  return response;
}

