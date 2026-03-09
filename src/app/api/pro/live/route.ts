import {
  ESPORTS_CACHE_KEYS,
  esportsAPIClient,
  isEsportsLiveEnabled,
  type EsportsSchedule,
} from "@/lib/esports-api";

function getUpcoming(schedule: EsportsSchedule, limit: number) {
  return schedule.events
    .filter((event) => event.state === "unstarted" && event.type === "match")
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
    .slice(0, limit);
}

export async function GET() {
  if (!isEsportsLiveEnabled()) {
    return Response.json({
      isLive: false,
      disabled: true,
      upcoming: [],
      message: "Live esports feed is disabled.",
    });
  }

  try {
    const liveData = await esportsAPIClient.getLive();

    if (liveData.events.length === 0) {
      const schedule = await esportsAPIClient.getSchedule();
      const upcoming = getUpcoming(schedule, 5);

      return Response.json({
        isLive: false,
        upcoming,
        message: "No pro games currently live",
        lastUpdated: new Date().toISOString(),
      });
    }

    return Response.json({
      isLive: true,
      events: liveData.events,
      games: liveData.games,
      lastUpdated: new Date().toISOString(),
      stale: false,
    });
  } catch (error) {
    console.error("[ProLiveAPI] Failed to fetch live esports data:", error);

    const fallbackLive = esportsAPIClient.getLastSuccessful<{
      events: unknown[];
      games: unknown[];
    }>(ESPORTS_CACHE_KEYS.live);

    if (fallbackLive?.value) {
      const liveEvents = Array.isArray(fallbackLive.value.events)
        ? fallbackLive.value.events
        : [];

      return Response.json({
        isLive: liveEvents.length > 0,
        events: liveEvents,
        games: Array.isArray(fallbackLive.value.games) ? fallbackLive.value.games : [],
        stale: true,
        message: "Showing last known live state.",
        lastUpdated: new Date(fallbackLive.updatedAt).toISOString(),
      });
    }

    const fallbackSchedule = esportsAPIClient.getLastSuccessful<EsportsSchedule>(
      ESPORTS_CACHE_KEYS.scheduleAll,
    );

    return Response.json({
      isLive: false,
      error: true,
      stale: true,
      upcoming: fallbackSchedule ? getUpcoming(fallbackSchedule.value, 5) : [],
      lastUpdated: fallbackSchedule
        ? new Date(fallbackSchedule.updatedAt).toISOString()
        : null,
      message: "Esports data temporarily unavailable",
    });
  }
}
