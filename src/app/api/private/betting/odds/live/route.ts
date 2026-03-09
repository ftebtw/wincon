import { NextResponse } from "next/server";

import { isAuthorizedBettingRequest } from "@/lib/betting/auth";
import { oddsClient } from "@/lib/betting/odds-api";

export async function GET(request: Request) {
  if (!isAuthorizedBettingRequest(request)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const live = await oddsClient.getLiveOdds();
    return NextResponse.json({
      fixtures: live,
      fetchedAt: new Date().toISOString(),
      error: null,
    });
  } catch (error) {
    return NextResponse.json({
      fixtures: [],
      fetchedAt: new Date().toISOString(),
      error:
        error instanceof Error
          ? error.message
          : "Unable to load live odds.",
    });
  }
}

