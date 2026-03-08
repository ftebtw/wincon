import {
  ESPORTS_CACHE_KEYS,
  esportsAPIClient,
  isEsportsLiveEnabled,
  type EsportsLeague,
  type EsportsSchedule,
} from "@/lib/esports-api";

function normalizeLeagueSlug(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function splitSchedule(events: EsportsSchedule["events"]) {
  const sorted = [...events].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));

  return {
    results: sorted.filter((event) => event.state === "completed").slice(-10).reverse(),
    upcoming: sorted.filter((event) => event.state === "unstarted").slice(0, 10),
    live: sorted.filter((event) => event.state === "inProgress"),
  };
}

function findLeagueIdBySlug(leagues: EsportsLeague[], leagueSlug: string | null): string | undefined {
  if (!leagueSlug) {
    return undefined;
  }

  return leagues.find((league) => league.slug.toLowerCase() === leagueSlug)?.id;
}

export async function GET(request: Request) {
  if (!isEsportsLiveEnabled()) {
    return Response.json({
      disabled: true,
      leagues: [],
      results: [],
      upcoming: [],
      live: [],
      message: "Live esports feed is disabled.",
    });
  }

  const { searchParams } = new URL(request.url);
  const requestedLeagueSlug = normalizeLeagueSlug(searchParams.get("league"));

  try {
    const leagues = await esportsAPIClient.getLeagues();
    const leagueId = findLeagueIdBySlug(leagues, requestedLeagueSlug);
    const schedule = await esportsAPIClient.getSchedule(leagueId);
    const { results, upcoming, live } = splitSchedule(schedule.events);

    return Response.json({
      leagues,
      results,
      upcoming,
      live,
      lastUpdated: new Date().toISOString(),
      stale: false,
    });
  } catch (error) {
    console.error("[ProScheduleAPI] Failed to fetch schedule:", error);

    const fallbackLeagues = esportsAPIClient.getLastSuccessful<EsportsLeague[]>(
      ESPORTS_CACHE_KEYS.leagues,
    )?.value ?? [];

    const fallbackLeagueId = findLeagueIdBySlug(fallbackLeagues, requestedLeagueSlug);
    const scheduleCacheKey = fallbackLeagueId
      ? `${ESPORTS_CACHE_KEYS.scheduleByLeague}${fallbackLeagueId}`
      : ESPORTS_CACHE_KEYS.scheduleAll;

    const fallbackSchedule = esportsAPIClient.getLastSuccessful<EsportsSchedule>(scheduleCacheKey)
      ?? esportsAPIClient.getLastSuccessful<EsportsSchedule>(ESPORTS_CACHE_KEYS.scheduleAll);

    const events = fallbackSchedule?.value.events ?? [];
    const { results, upcoming, live } = splitSchedule(events);

    return Response.json({
      leagues: fallbackLeagues,
      results,
      upcoming,
      live,
      stale: true,
      error: true,
      message: "Esports schedule temporarily unavailable. Showing cached data.",
      lastUpdated: fallbackSchedule
        ? new Date(fallbackSchedule.updatedAt).toISOString()
        : null,
    });
  }
}
