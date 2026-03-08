"use client";

import { useMemo, useState } from "react";

import { AllPlayersWPA } from "@/components/AllPlayersWPA";
import { PlayerContributionCard } from "@/components/PlayerContributionCard";
import { WPAContributionChart } from "@/components/WPAContributionChart";
import { Button } from "@/components/ui/button";
import type { MatchAnalysisResponse } from "@/lib/types/match-analysis";

type ContributionSectionProps = {
  winProbTimeline: MatchAnalysisResponse["winProbTimeline"];
  wpa: MatchAnalysisResponse["wpa"];
  playerPuuid: string;
  keyMoments: MatchAnalysisResponse["keyMoments"];
};

export function ContributionSection({
  winProbTimeline,
  wpa,
  playerPuuid,
  keyMoments,
}: ContributionSectionProps) {
  const [showOverlay, setShowOverlay] = useState(true);

  const playerKeyEvents = useMemo(
    () =>
      wpa.events
        .map((event) => ({
          event,
          playerImpact: event.attributions
            .filter((attribution) => attribution.puuid === playerPuuid)
            .reduce((sum, attribution) => sum + attribution.wpaValue, 0),
        }))
        .filter((entry) => Math.abs(entry.playerImpact) >= 0.01)
        .sort((a, b) => Math.abs(b.playerImpact) - Math.abs(a.playerImpact))
        .slice(0, 10),
    [playerPuuid, wpa.events],
  );

  const onEventClick = (event: (typeof playerKeyEvents)[number]["event"]) => {
    const nearestMoment = [...keyMoments]
      .sort(
        (a, b) =>
          Math.abs(a.timestamp - event.timestamp) - Math.abs(b.timestamp - event.timestamp),
      )[0];
    const targetId = nearestMoment
      ? `moment-${nearestMoment.timestamp}`
      : `moment-${event.timestamp}`;
    const target = document.getElementById(targetId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button
          type="button"
          size="sm"
          variant={showOverlay ? "default" : "outline"}
          onClick={() => setShowOverlay((previous) => !previous)}
        >
          {showOverlay ? "Hide WPA Overlay" : "Show WPA Overlay"}
        </Button>
      </div>

      <WPAContributionChart
        teamWinProbTimeline={winProbTimeline}
        playerWPATimeline={showOverlay ? wpa.playerSummary.wpaTimeline : []}
        keyEvents={playerKeyEvents.map((entry) => entry.event)}
        onEventClick={onEventClick}
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_1.5fr]">
        <PlayerContributionCard
          summary={wpa.playerSummary}
          totalPlayers={wpa.allPlayers.length}
        />
        <AllPlayersWPA summaries={wpa.allPlayers} playerPuuid={playerPuuid} />
      </div>
    </div>
  );
}
