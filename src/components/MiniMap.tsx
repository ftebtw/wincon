"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { Eye, Skull, Swords } from "lucide-react";

import { cn } from "@/lib/utils";

type DeathMarker = {
  id?: string;
  x: number;
  y: number;
  champion: string;
  timestamp: number;
  type: string;
  severity?: "critical" | "major" | "minor" | "info";
};

type WardMarker = {
  id?: string;
  x: number;
  y: number;
  timestamp: number;
  type: "placed" | "killed";
};

type TeamfightMarker = {
  id?: string;
  x: number;
  y: number;
  timestamp: number;
  winner: string;
};

export interface MiniMapProps {
  deaths: DeathMarker[];
  wards: WardMarker[];
  teamfights?: TeamfightMarker[];
  selectedEvent?: string;
  onEventClick?: (eventId: string) => void;
  width?: number;
  height?: number;
}

const MAP_RANGE = 15_000;

function toPixelX(gameX: number, width: number): number {
  return (Math.max(0, Math.min(MAP_RANGE, gameX)) / MAP_RANGE) * width;
}

function toPixelY(gameY: number, height: number): number {
  return height - (Math.max(0, Math.min(MAP_RANGE, gameY)) / MAP_RANGE) * height;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function MiniMap({
  deaths,
  wards,
  teamfights = [],
  selectedEvent,
  onEventClick,
  width = 640,
  height = 640,
}: MiniMapProps) {
  const [hoverText, setHoverText] = useState<string | null>(null);

  const deathPoints = useMemo(
    () =>
      deaths.map((death, index) => ({
        ...death,
        id: death.id ?? `death-${death.timestamp}-${index}`,
        px: toPixelX(death.x, width),
        py: toPixelY(death.y, height),
      })),
    [deaths, height, width],
  );
  const wardPoints = useMemo(
    () =>
      wards.map((ward, index) => ({
        ...ward,
        id: ward.id ?? `ward-${ward.type}-${ward.timestamp}-${index}`,
        px: toPixelX(ward.x, width),
        py: toPixelY(ward.y, height),
      })),
    [height, wards, width],
  );
  const teamfightPoints = useMemo(
    () =>
      teamfights.map((fight, index) => ({
        ...fight,
        id: fight.id ?? `fight-${fight.timestamp}-${index}`,
        px: toPixelX(fight.x, width),
        py: toPixelY(fight.y, height),
      })),
    [height, teamfights, width],
  );

  return (
    <div
      className="relative mx-auto w-full max-w-[720px] overflow-hidden rounded-xl border border-border/70 bg-[#0f1420]"
      style={{ aspectRatio: `${width}/${height}` }}
    >
      <Image
        src="/summoners-rift.svg"
        alt="Summoner's Rift minimap"
        fill
        className="object-cover opacity-90"
      />

      {deathPoints.map((death) => {
        const isSelected = selectedEvent === death.id;
        const size =
          death.severity === "critical" ? 24 : death.severity === "major" ? 20 : 16;
        return (
          <button
            key={death.id}
            type="button"
            onClick={() => onEventClick?.(death.id)}
            onMouseEnter={() =>
              setHoverText(
                `${formatTimestamp(death.timestamp)} ${death.champion} death (${death.type})`,
              )
            }
            onMouseLeave={() => setHoverText(null)}
            className={cn(
              "absolute z-20 grid place-items-center rounded-full border border-black/40 bg-[#ef4444] text-white shadow-md transition",
              isSelected && "scale-125 ring-2 ring-primary ring-offset-1 ring-offset-[#0f1420]",
            )}
            style={{
              left: death.px,
              top: death.py,
              width: size,
              height: size,
              transform: "translate(-50%, -50%)",
            }}
            title={`${formatTimestamp(death.timestamp)} ${death.champion} death`}
          >
            <Skull className="size-3" />
          </button>
        );
      })}

      {wardPoints.map((ward) => {
        const isSelected = selectedEvent === ward.id;
        return (
          <button
            key={ward.id}
            type="button"
            onClick={() => onEventClick?.(ward.id)}
            onMouseEnter={() =>
              setHoverText(
                `${formatTimestamp(ward.timestamp)} ${ward.type === "placed" ? "Ward placed" : "Ward cleared"}`,
              )
            }
            onMouseLeave={() => setHoverText(null)}
            className={cn(
              "absolute z-10 grid place-items-center rounded-full border border-black/40 text-white shadow-sm transition",
              ward.type === "placed" ? "bg-[#eab308]" : "bg-[#b91c1c]",
              isSelected && "scale-125 ring-2 ring-primary ring-offset-1 ring-offset-[#0f1420]",
            )}
            style={{
              left: ward.px,
              top: ward.py,
              width: 14,
              height: 14,
              transform: "translate(-50%, -50%)",
            }}
            title={`${formatTimestamp(ward.timestamp)} ward ${ward.type}`}
          >
            <Eye className="size-2.5" />
          </button>
        );
      })}

      {teamfightPoints.map((fight) => {
        const isSelected = selectedEvent === fight.id;
        const color =
          fight.winner === "blue"
            ? "#3b82f6"
            : fight.winner === "red"
              ? "#ef4444"
              : "#94a3b8";
        return (
          <button
            key={fight.id}
            type="button"
            onClick={() => onEventClick?.(fight.id)}
            onMouseEnter={() =>
              setHoverText(
                `${formatTimestamp(fight.timestamp)} teamfight (${fight.winner.toUpperCase()})`,
              )
            }
            onMouseLeave={() => setHoverText(null)}
            className={cn(
              "absolute z-30 grid place-items-center rounded-full border-2 border-white/70 text-white shadow-md transition",
              isSelected && "scale-110 ring-2 ring-primary ring-offset-1 ring-offset-[#0f1420]",
            )}
            style={{
              left: fight.px,
              top: fight.py,
              width: 28,
              height: 28,
              transform: "translate(-50%, -50%)",
              backgroundColor: color,
            }}
            title={`${formatTimestamp(fight.timestamp)} teamfight`}
          >
            <Swords className="size-3.5" />
          </button>
        );
      })}

      <div className="pointer-events-none absolute bottom-2 left-2 rounded-md border border-border/70 bg-[#0a0e14]/90 px-2 py-1 text-[11px] text-muted-foreground">
        {hoverText ?? "Hover markers for details. Click to jump to event."}
      </div>
    </div>
  );
}
