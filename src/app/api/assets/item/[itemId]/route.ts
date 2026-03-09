import { NextResponse } from "next/server";

import { cdragonService } from "@/lib/cdragon";
import { getItems, getLatestVersion } from "@/lib/data-dragon";

type CacheEntry = {
  expiresAt: number;
  url: string;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const iconCache = new Map<number, CacheEntry>();

function fileNameFromIconPath(iconPath: string | undefined): string | null {
  if (!iconPath) {
    return null;
  }

  const segments = iconPath.split("/");
  const candidate = segments[segments.length - 1];
  if (!candidate || !candidate.toLowerCase().endsWith(".png")) {
    return null;
  }

  return candidate.toLowerCase();
}

function buildDdragonFallbackUrl(itemId: number, version: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${itemId}.png`;
}

async function resolveItemIconUrl(itemId: number): Promise<string> {
  const cached = iconCache.get(itemId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const ddragonItems = await getItems().catch(() => null);
  const ddragonItem = ddragonItems?.get(itemId);
  if (ddragonItem?.iconUrl) {
    iconCache.set(itemId, {
      url: ddragonItem.iconUrl,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return ddragonItem.iconUrl;
  }

  const cdragonItems = await cdragonService.getItems("latest").catch(() => []);
  const cdragonItem = cdragonItems.find((entry) => entry.id === itemId);
  const fileName = fileNameFromIconPath(cdragonItem?.iconPath);

  if (fileName) {
    const cdragonUrl = cdragonService.getAssetUrl(
      `/plugins/rcp-be-lol-game-data/global/default/assets/items/icons2d/${fileName}`,
      "latest",
    );
    iconCache.set(itemId, {
      url: cdragonUrl,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return cdragonUrl;
  }

  const version = await getLatestVersion().catch(
    () => process.env.NEXT_PUBLIC_DATA_DRAGON_VERSION ?? "16.5.1",
  );
  const fallback = buildDdragonFallbackUrl(itemId, version);
  iconCache.set(itemId, {
    url: fallback,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  return fallback;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const { itemId } = await params;
  const parsed = Number(itemId);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return NextResponse.json({ error: "Invalid item id." }, { status: 400 });
  }

  const url = await resolveItemIconUrl(parsed);
  const response = NextResponse.redirect(url, { status: 307 });
  response.headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
  return response;
}
