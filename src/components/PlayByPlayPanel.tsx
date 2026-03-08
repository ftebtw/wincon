"use client";

import { useMemo, useState } from "react";

import { KeyMomentCard } from "@/components/KeyMomentCard";
import { MiniMap } from "@/components/MiniMap";
import { RankBenchmarkBars } from "@/components/RankBenchmarkBars";
import { TeamfightBreakdown } from "@/components/TeamfightBreakdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MatchAnalysisResponse } from "@/lib/types/match-analysis";
import type { KeyMoment } from "@/lib/win-probability";
import { cn } from "@/lib/utils";

export interface PlayByPlayPanelProps {
  keyMoments: Array<KeyMoment & { context?: string }>;
  playByPlay: MatchAnalysisResponse["playByPlay"];
  rankBenchmarks: MatchAnalysisResponse["rankBenchmarks"];
  playerChampion: string;
}

type MiniMapMode = "deaths" | "wards" | "teamfights";

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function signedPercent(value: number): string {
  const pct = Math.round(value * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function getSeverityClass(severity: MatchAnalysisResponse["playByPlay"]["events"][number]["severity"]): string {
  if (severity === "critical") {
    return "border-l-[#ef4444] bg-[#ef4444]/5";
  }
  if (severity === "major") {
    return "border-l-[#f97316] bg-[#f97316]/5";
  }
  if (severity === "minor") {
    return "border-l-[#f59e0b] bg-[#f59e0b]/5";
  }
  return "border-l-border bg-background/20";
}

export function PlayByPlayPanel({
  keyMoments,
  playByPlay,
  rankBenchmarks,
  playerChampion,
}: PlayByPlayPanelProps) {
  const [mapMode, setMapMode] = useState<MiniMapMode>("deaths");
  const [selectedEvent, setSelectedEvent] = useState<string | undefined>();

  const keyMomentsChronological = useMemo(
    () => [...keyMoments].sort((a, b) => a.timestamp - b.timestamp),
    [keyMoments],
  );
  const eventsChronological = useMemo(
    () => [...playByPlay.events].sort((a, b) => a.timestamp - b.timestamp),
    [playByPlay.events],
  );
  const teamfightsChronological = useMemo(
    () => [...playByPlay.teamfights].sort((a, b) => a.startTime - b.startTime),
    [playByPlay.teamfights],
  );

  const deathsForMap = useMemo(
    () =>
      playByPlay.deathMap.deaths.map((death, index) => {
        const matchingEvent = eventsChronological.find(
          (event) =>
            event.type === "death" && Math.abs(event.timestamp - death.timestamp) <= 1000,
        );
        return {
          ...death,
          id: matchingEvent?.id ?? death.id ?? `death-${death.timestamp}-${index}`,
        };
      }),
    [eventsChronological, playByPlay.deathMap.deaths],
  );
  const wardsForMap = useMemo(
    () =>
      playByPlay.wardMap.wards.map((ward, index) => {
        const matchingEvent = eventsChronological.find(
          (event) =>
            event.type === "ward" && Math.abs(event.timestamp - ward.timestamp) <= 1000,
        );
        return {
          ...ward,
          id: matchingEvent?.id ?? ward.id ?? `ward-${ward.timestamp}-${index}`,
        };
      }),
    [eventsChronological, playByPlay.wardMap.wards],
  );
  const teamfightsForMap = useMemo(
    () =>
      teamfightsChronological.map((fight, index) => ({
        id: fight.id ?? `fight-${fight.startTime}-${index}`,
        x: fight.position.x,
        y: fight.position.y,
        timestamp: fight.startTime,
        winner: fight.winner,
      })),
    [teamfightsChronological],
  );

  const displayedDeaths = mapMode === "deaths" ? deathsForMap : [];
  const displayedWards = mapMode === "wards" ? wardsForMap : [];
  const displayedTeamfights = mapMode === "teamfights" ? teamfightsForMap : [];

  const handleMapClick = (eventId: string) => {
    setSelectedEvent(eventId);
    const target = document.getElementById(eventId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  return (
    <div className="space-y-6">
      <Card className="border-border/70">
        <CardHeader className="space-y-3">
          <CardTitle>Mini-Map Event View</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={mapMode === "deaths" ? "default" : "outline"}
              onClick={() => setMapMode("deaths")}
            >
              Deaths
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mapMode === "wards" ? "default" : "outline"}
              onClick={() => setMapMode("wards")}
            >
              Wards
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mapMode === "teamfights" ? "default" : "outline"}
              onClick={() => setMapMode("teamfights")}
            >
              Teamfights
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <MiniMap
            deaths={displayedDeaths}
            wards={displayedWards}
            teamfights={displayedTeamfights}
            selectedEvent={selectedEvent}
            onEventClick={handleMapClick}
          />
        </CardContent>
      </Card>

      <Card className="border-border/70">
        <CardHeader>
          <CardTitle>Deep Match Review</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="key-moments">
            <TabsList variant="line" className="mb-4 grid w-full grid-cols-3">
              <TabsTrigger value="key-moments">Key Moments</TabsTrigger>
              <TabsTrigger value="play-by-play">Play-by-Play</TabsTrigger>
              <TabsTrigger value="teamfights">Teamfights</TabsTrigger>
            </TabsList>

            <TabsContent value="key-moments" className="space-y-4">
              {keyMomentsChronological.map((moment) => (
                <KeyMomentCard key={moment.timestamp} moment={moment} />
              ))}
            </TabsContent>

            <TabsContent value="play-by-play" className="space-y-3">
              {eventsChronological.map((event) => {
                const involved = event.involvedPlayers
                  .map((player) => player.champion)
                  .filter((champion) => champion && champion !== "Unknown")
                  .slice(0, 4)
                  .join(", ");
                return (
                  <div
                    key={event.id}
                    id={event.id}
                    className={cn(
                      "rounded-md border border-border/70 border-l-4 p-3",
                      getSeverityClass(event.severity),
                      selectedEvent === event.id && "ring-2 ring-primary",
                    )}
                  >
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{formatTimestamp(event.timestamp)}</Badge>
                        <Badge variant="outline" className="uppercase">
                          {event.type.replace(/_/g, " ")}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={cn(
                            event.wpaDelta >= 0
                              ? "border-[#10b981]/70 text-[#34d399]"
                              : "border-[#ef4444]/70 text-[#fca5a5]",
                          )}
                        >
                          {signedPercent(event.wpaDelta)}
                        </Badge>
                      </div>
                      <Badge variant={event.aiRelevant ? "default" : "outline"}>
                        {event.aiRelevant ? "AI Relevant" : "Info"}
                      </Badge>
                    </div>
                    <p className="text-sm text-foreground">{event.description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Gold state: {event.context.goldState} ({event.context.goldDiff >= 0 ? "+" : ""}
                      {event.context.goldDiff}) | Lv {event.context.playerLevel} vs{" "}
                      {event.context.opponentLevel}
                      {event.context.objectivesUp.length > 0
                        ? ` | Objectives soon: ${event.context.objectivesUp.join(", ")}`
                        : ""}
                    </p>
                    {involved ? (
                      <p className="mt-1 text-xs text-muted-foreground">Involved: {involved}</p>
                    ) : null}
                  </div>
                );
              })}
            </TabsContent>

            <TabsContent value="teamfights" className="space-y-4">
              {teamfightsChronological.map((fight) => (
                <TeamfightBreakdown
                  key={fight.id}
                  teamfight={fight}
                  playerChampion={playerChampion}
                />
              ))}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <RankBenchmarkBars
        benchmarks={rankBenchmarks.playerTier}
        multiRank={rankBenchmarks}
      />
    </div>
  );
}

