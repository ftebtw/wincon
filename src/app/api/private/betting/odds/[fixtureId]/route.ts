import { NextResponse } from "next/server";

import { isAuthorizedBettingRequest } from "@/lib/betting/auth";
import { oddsClient } from "@/lib/betting/odds-api";

export async function GET(
  request: Request,
  context: { params: Promise<{ fixtureId: string }> },
) {
  if (!isAuthorizedBettingRequest(request)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { fixtureId } = await context.params;
  try {
    const [fixtureOdds, bestOdds, history] = await Promise.all([
      oddsClient.getFixtureOdds(fixtureId),
      oddsClient.getBestOdds(fixtureId),
      oddsClient.getHistoricalOdds(fixtureId).catch(() => []),
    ]);

    return NextResponse.json({
      fixtureOdds,
      bestOdds,
      history,
      fetchedAt: new Date().toISOString(),
      error: null,
    });
  } catch (error) {
    return NextResponse.json({
      fixtureOdds: null,
      bestOdds: null,
      history: [],
      fetchedAt: new Date().toISOString(),
      error:
        error instanceof Error
          ? error.message
          : `Unable to load odds for fixture ${fixtureId}.`,
    });
  }
}
