"use client";

import {
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";

import type { TeamStrengthProfile } from "@/lib/types/pro";

type ProTeamRadarProps = {
  team: TeamStrengthProfile;
  leagueAverage?: TeamStrengthProfile | null;
};

export function ProTeamRadar({ team, leagueAverage }: ProTeamRadarProps) {
  const baseline = leagueAverage ?? {
    earlyGame: 50,
    objectiveControl: 50,
    teamfighting: 50,
    closingSpeed: 50,
    consistency: 50,
  };

  const data = [
    { metric: "Early", team: team.earlyGame, league: baseline.earlyGame },
    { metric: "Objectives", team: team.objectiveControl, league: baseline.objectiveControl },
    { metric: "Fighting", team: team.teamfighting, league: baseline.teamfighting },
    { metric: "Closing", team: team.closingSpeed, league: baseline.closingSpeed },
    { metric: "Consistency", team: team.consistency, league: baseline.consistency },
  ];

  return (
    <div className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="70%">
          <PolarGrid stroke="rgba(148, 163, 184, 0.35)" />
          <PolarAngleAxis
            dataKey="metric"
            tick={{ fill: "#cbd5e1", fontSize: 12 }}
          />
          <Radar
            dataKey="league"
            stroke="#94a3b8"
            fill="#94a3b8"
            fillOpacity={0.15}
            name="League Avg"
          />
          <Radar
            dataKey="team"
            stroke="#3b82f6"
            fill="#3b82f6"
            fillOpacity={0.28}
            name="Team"
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}