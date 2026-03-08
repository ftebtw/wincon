import { NextResponse } from "next/server";

import { progressTracker } from "@/lib/progress-tracker";

type ProgressTimelineRouteContext = {
  params: Promise<{
    puuid: string;
  }>;
};

export async function GET(request: Request, { params }: ProgressTimelineRouteContext) {
  const { puuid } = await params;
  const { searchParams } = new URL(request.url);
  const weeks = Math.max(2, Math.min(Number(searchParams.get("weeks") ?? 12), 24));

  try {
    const timeline = await progressTracker.getProgressTimeline(puuid, weeks);
    return NextResponse.json(timeline);
  } catch (error) {
    console.error("[ProgressTimelineRoute] Failed:", error);
    return NextResponse.json(
      { error: "Failed to load progress timeline." },
      { status: 500 },
    );
  }
}