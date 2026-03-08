import { NextResponse } from "next/server";

import { progressTracker } from "@/lib/progress-tracker";

type ProgressRouteContext = {
  params: Promise<{
    puuid: string;
  }>;
};

export async function GET(request: Request, { params }: ProgressRouteContext) {
  const { puuid } = await params;
  const { searchParams } = new URL(request.url);
  const periodParam = (searchParams.get("period") ?? "week").toLowerCase();
  const period = periodParam === "month" ? "month" : "week";

  try {
    const report = await progressTracker.generateReport(puuid, period);
    return NextResponse.json(report);
  } catch (error) {
    console.error("[ProgressRoute] Failed:", error);
    return NextResponse.json(
      { error: "Failed to compute progress report." },
      { status: 500 },
    );
  }
}