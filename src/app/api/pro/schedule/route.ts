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
  const matchEvents = events.filter((event) => event.type === "match");
  const sorted = [...matchEvents].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));

  return {
    results: sorted.filter((event) => event.state === "completed").slice(-10).reverse(),
    upcoming: sorted.filter((event) => event.state === "unstarted").slice(0, 10),
    live: sorted.filter((event) => event.state === "inProgress"),
  };
}

function filterByLeagueSlug(events: EsportsSchedule["events"], leagueSlug: string | null) {
  if (!leagueSlug) {
    return events;
  }

  return events.filter((event) => event.league.slug.toLowerCase() === leagueSlug);
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
    const schedule = await esportsAPIClient.getSchedule();
    const filteredEvents = filterByLeagueSlug(schedule.events, requestedLeagueSlug);
    const localSplit = splitSchedule(filteredEvents);
    const globalSplit = splitSchedule(schedule.events);
    const usedGlobalFallback =
      Boolean(requestedLeagueSlug) &&
      localSplit.upcoming.length === 0 &&
      localSplit.live.length === 0;

    return Response.json({
      leagues,
      results: localSplit.results,
      upcoming: usedGlobalFallback ? globalSplit.upcoming : localSplit.upcoming,
      live: usedGlobalFallback ? globalSplit.live : localSplit.live,
      lastUpdated: new Date().toISOString(),
      stale: false,
      fallbackToGlobal: usedGlobalFallback,
      message: usedGlobalFallback
        ? "Selected league has no upcoming/live matches right now. Showing global upcoming matches."
        : undefined,
    });
  } catch (error) {
    console.error("[ProScheduleAPI] Failed to fetch schedule:", error);

    const fallbackLeagues = esportsAPIClient.getLastSuccessful<EsportsLeague[]>(
      ESPORTS_CACHE_KEYS.leagues,
    )?.value ?? [];

    const fallbackSchedule = esportsAPIClient.getLastSuccessful<EsportsSchedule>(
      ESPORTS_CACHE_KEYS.scheduleAll,
    );

    const events = fallbackSchedule?.value.events ?? [];
    const localSplit = splitSchedule(filterByLeagueSlug(events, requestedLeagueSlug));
    const globalSplit = splitSchedule(events);
    const usedGlobalFallback =
      Boolean(requestedLeagueSlug) &&
      localSplit.upcoming.length === 0 &&
      localSplit.live.length === 0;

    return Response.json({
      leagues: fallbackLeagues,
      results: localSplit.results,
      upcoming: usedGlobalFallback ? globalSplit.upcoming : localSplit.upcoming,
      live: usedGlobalFallback ? globalSplit.live : localSplit.live,
      stale: true,
      error: true,
      message: "Esports schedule temporarily unavailable. Showing cached data.",
      lastUpdated: fallbackSchedule
        ? new Date(fallbackSchedule.updatedAt).toISOString()
        : null,
      fallbackToGlobal: usedGlobalFallback,
    });
  }
}
