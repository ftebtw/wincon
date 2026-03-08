import { NextResponse } from "next/server";

import {
  similaritySearchEngine,
  type SearchOptions,
} from "@/lib/similarity-search";
import { cachedRiotAPI } from "@/lib/cache";
import { RiotAPIError } from "@/lib/riot-api";
import type { MatchDto, MatchTimelineDto } from "@/lib/types/riot";

const PLATFORM_TO_REGION: Record<string, string> = {
  na1: "americas",
  br1: "americas",
  la1: "americas",
  la2: "americas",
  oc1: "americas",
  euw1: "europe",
  eun1: "europe",
  tr1: "europe",
  ru: "europe",
  kr: "asia",
  jp1: "asia",
  ph2: "sea",
  sg2: "sea",
  th2: "sea",
  tw2: "sea",
  vn2: "sea",
};

const FALLBACK_REGIONS = ["americas", "europe", "asia", "sea"];

type SimilarRouteBody = {
  matchId?: string;
  playerPuuid?: string;
  minute?: number;
  options?: SearchOptions;
};

function getRegionCandidates(matchId: string): string[] {
  const platform = matchId.split("_")[0]?.toLowerCase() ?? "";
  const inferred = PLATFORM_TO_REGION[platform];

  if (!inferred) {
    return [...FALLBACK_REGIONS];
  }

  return [inferred, ...FALLBACK_REGIONS.filter((region) => region !== inferred)];
}

async function fetchMatchWithRegionFallback(
  matchId: string,
): Promise<{ match: MatchDto; timeline: MatchTimelineDto }> {
  for (const region of getRegionCandidates(matchId)) {
    try {
      const [match, timeline] = await Promise.all([
        cachedRiotAPI.getMatch(matchId, region),
        cachedRiotAPI.getMatchTimeline(matchId, region),
      ]);

      return { match, timeline };
    } catch (error) {
      if (error instanceof RiotAPIError && error.status === 404) {
        continue;
      }

      throw error;
    }
  }

  throw new RiotAPIError({
    status: 404,
    message: "Match not found.",
    url: `/lol/match/v5/matches/${matchId}`,
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SimilarRouteBody;
    const matchId = body.matchId?.trim();
    const playerPuuid = body.playerPuuid?.trim();
    const minute = Number(body.minute ?? 15);

    if (!matchId || !playerPuuid) {
      return NextResponse.json(
        { error: "matchId and playerPuuid are required." },
        { status: 400 },
      );
    }

    if (!Number.isFinite(minute) || minute < 1 || minute > 60) {
      return NextResponse.json(
        { error: "minute must be a valid number between 1 and 60." },
        { status: 400 },
      );
    }

    const { match, timeline } = await fetchMatchWithRegionFallback(matchId);
    const result = await similaritySearchEngine.search(
      match,
      timeline,
      playerPuuid,
      Math.floor(minute),
      body.options,
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RiotAPIError) {
      if (error.status === 404) {
        return NextResponse.json({ error: "Match not found." }, { status: 404 });
      }

      if (error.status === 429) {
        return NextResponse.json(
          {
            error: "Riot API rate limit exceeded while preparing similarity search.",
            retryAfter: error.retryAfter,
          },
          { status: 429 },
        );
      }

      if (error.status === 503 || error.status === 500) {
        return NextResponse.json(
          { error: "Riot API service is temporarily unavailable." },
          { status: 503 },
        );
      }
    }

    console.error("[SimilarRoute] Unexpected error:", error);
    return NextResponse.json(
      { error: "Failed to run similarity search." },
      { status: 500 },
    );
  }
}
