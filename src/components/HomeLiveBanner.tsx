"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type HomeLivePayload = {
  isLive: boolean;
  events?: Array<{
    league: { name: string };
    match?: {
      teams: Array<{ name: string; code: string }>;
    };
  }>;
};

export function HomeLiveBanner() {
  const [data, setData] = useState<HomeLivePayload | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/pro/live", { cache: "no-store" });
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as HomeLivePayload;
        if (!cancelled) {
          setData(payload);
        }
      } catch {
        // Ignore live banner failures on homepage.
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!data?.isLive || !data.events || data.events.length === 0) {
    return null;
  }

  const event = data.events[0];
  const teamA = event.match?.teams?.[0]?.code || event.match?.teams?.[0]?.name || "Team A";
  const teamB = event.match?.teams?.[1]?.code || event.match?.teams?.[1]?.name || "Team B";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-4">
      <Link
        href="/pro"
        className="block rounded-md border border-[#ef4444]/40 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#fecaca] transition-colors hover:border-[#ef4444]/70"
      >
        LIVE: {teamA} vs {teamB} ({event.league.name}) - Game in progress {"->"} Watch in Pro Section
      </Link>
    </div>
  );
}
