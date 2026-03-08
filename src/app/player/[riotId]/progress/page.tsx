import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import { ErrorCard } from "@/components/ErrorCard";
import { ProgressDashboard } from "@/components/ProgressDashboard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { progressTracker } from "@/lib/progress-tracker";
import type { PlayerLookupResponse } from "@/lib/types/player";

type PlayerProgressPageProps = {
  params: Promise<{
    riotId: string;
  }>;
};

function parseRiotIdSlug(riotId: string): { gameName: string; tagLine: string } | null {
  const decoded = decodeURIComponent(riotId);
  const splitIndex = decoded.lastIndexOf("-");
  if (splitIndex <= 0 || splitIndex === decoded.length - 1) {
    return null;
  }

  const gameName = decoded.slice(0, splitIndex).trim();
  const tagLine = decoded.slice(splitIndex + 1).trim();
  if (!gameName || !tagLine) {
    return null;
  }

  return { gameName, tagLine };
}

function getBaseUrl(headerStore: Awaited<ReturnType<typeof headers>>): string {
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const protocol = headerStore.get("x-forwarded-proto") ?? "http";
  return host ? `${protocol}://${host}` : "http://localhost:3000";
}

async function getPlayerLookupData(
  riotId: string,
): Promise<{ ok: true; data: PlayerLookupResponse } | { ok: false; status: number; message: string }> {
  const headerStore = await headers();
  const baseUrl = getBaseUrl(headerStore);

  const response = await fetch(`${baseUrl}/api/player/${encodeURIComponent(riotId)}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      status: response.status,
      message: payload.error ?? "Failed to load player profile.",
    };
  }

  return {
    ok: true,
    data: (await response.json()) as PlayerLookupResponse,
  };
}

export async function generateMetadata({
  params,
}: PlayerProgressPageProps): Promise<Metadata> {
  const { riotId } = await params;
  const parsed = parseRiotIdSlug(riotId);
  const fallbackTitle = parsed
    ? `${parsed.gameName}#${parsed.tagLine} Progress`
    : "Player Progress";

  const playerLookup = await getPlayerLookupData(riotId);
  if (!playerLookup.ok) {
    return {
      title: fallbackTitle,
      description: "Track weekly and monthly performance trends on WinCon.gg.",
    };
  }

  const { gameName, tagLine } = playerLookup.data.player;
  return {
    title: `${gameName}#${tagLine} Progress`,
    description: `Track rank trajectory and gameplay improvements for ${gameName} on WinCon.gg.`,
  };
}

export default async function PlayerProgressPage({ params }: PlayerProgressPageProps) {
  const { riotId } = await params;
  const playerLookup = await getPlayerLookupData(riotId);

  if (!playerLookup.ok) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-10">
        <ErrorCard
          statusCode={playerLookup.status}
          title={playerLookup.status === 404 ? "We couldn't find that summoner." : undefined}
          description={
            playerLookup.status === 404
              ? "Double-check the Riot ID and region."
              : playerLookup.message
          }
        />
      </div>
    );
  }

  const { player } = playerLookup.data;
  let initialReport: Awaited<ReturnType<typeof progressTracker.generateReport>> | null = null;
  let initialTimeline: Awaited<ReturnType<typeof progressTracker.getProgressTimeline>> = [];

  if (process.env.DATABASE_URL) {
    try {
      [initialReport, initialTimeline] = await Promise.all([
        progressTracker.generateReport(player.puuid, "week"),
        progressTracker.getProgressTimeline(player.puuid, 12),
      ]);
    } catch (error) {
      console.error("[ProgressPage] Failed to load initial progress:", error);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="text-2xl">
              {player.gameName} <span className="text-muted-foreground">#{player.tagLine}</span>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Track improvement trends, LP trajectory, and recurring mistakes.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href={`/player/${encodeURIComponent(riotId)}`}>Back to Profile</Link>
          </Button>
        </CardHeader>
        <CardContent>
          <ProgressDashboard
            puuid={player.puuid}
            initialReport={initialReport}
            initialTimeline={initialTimeline}
          />
        </CardContent>
      </Card>
    </div>
  );
}
