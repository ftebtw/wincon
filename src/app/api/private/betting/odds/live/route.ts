import { NextResponse } from "next/server";

import { isAuthorizedBettingRequest } from "@/lib/betting/auth";
import { oddsClient } from "@/lib/betting/odds-api";

export async function GET(request: Request) {
  if (!isAuthorizedBettingRequest(request)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const live = await oddsClient.getLiveOdds();
  return NextResponse.json({
    fixtures: live,
    fetchedAt: new Date().toISOString(),
  });
}

