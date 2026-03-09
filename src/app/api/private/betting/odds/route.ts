import { NextResponse } from "next/server";

import { isAuthorizedBettingRequest } from "@/lib/betting/auth";
import { oddsClient } from "@/lib/betting/odds-api";
import { PolymarketClient } from "@/lib/betting/polymarket";
import { unifiedBettingModel } from "@/lib/betting/unified-model";

function normalizeTeamName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function GET(request: Request) {
  if (!isAuthorizedBettingRequest(request)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const [fixtures, polymarketMarkets] = await Promise.all([
      oddsClient.getUpcomingFixtures(),
      new PolymarketClient().findLoLMarkets().catch(() => []),
    ]);

    const rows = await Promise.all(
      fixtures.map(async (fixtureOdds) => {
        const fixture = fixtureOdds.fixture;
        const best = oddsClient.summarizeBestOdds(fixtureOdds);
        const pinnacleProb = best.pinnacle
          ? oddsClient.removeVig(best.pinnacle.homeOdds, best.pinnacle.awayOdds)
          : fixtureOdds.consensusProb;

        const prediction = await unifiedBettingModel
          .predict({
            matchId: fixture.id,
            fixtureId: fixture.id,
            team1: fixture.homeTeam,
            team2: fixture.awayTeam,
            league: fixture.league,
            side: { team1: "blue" },
            event: fixture.league,
            marketProb: pinnacleProb.home,
          })
          .catch(() => null);

        const team1WinProb = prediction?.probability ?? 0.5;
        const team2WinProb = 1 - team1WinProb;

        const edgeVsPinnacle = team1WinProb - pinnacleProb.home;
        const side = edgeVsPinnacle >= 0 ? "home" : "away";

        const bestLeg = side === "home" ? best.bestHome : best.bestAway;
        const modelProbForSide = side === "home" ? team1WinProb : team2WinProb;
        const bestImpliedNoVig = oddsClient.removeVig(best.bestHome.homeOdds, best.bestAway.awayOdds);
        const bestImpliedProb = side === "home" ? bestImpliedNoVig.home : bestImpliedNoVig.away;

        const marketQuestions = polymarketMarkets.map((entry) => entry.question.toLowerCase());
        const homeKey = normalizeTeamName(fixture.homeTeam);
        const awayKey = normalizeTeamName(fixture.awayTeam);
        const polymarketAvailable = marketQuestions.some((question) => {
          const normalized = normalizeTeamName(question);
          return normalized.includes(homeKey) || normalized.includes(awayKey);
        });

        return {
          fixture,
          market: fixtureOdds.market,
          bookmakers: fixtureOdds.bookmakers,
          bestOdds: best,
          pinnacleProb,
          prediction: prediction
            ? {
                team1WinProb,
                team2WinProb,
                uncertainty: prediction.uncertainty,
                shouldBet: prediction.shouldBet,
              }
            : null,
          edgeVsPinnacle,
          edgeVsBest: modelProbForSide - bestImpliedProb,
          edgeDivergence: prediction?.edge ?? 0,
          uncertainty: prediction?.uncertainty ?? 0.08,
          shouldBet: prediction?.shouldBet ?? false,
          uniqueEdgeSources: prediction?.uniqueEdgeSources ?? [],
          recommendedBookmaker: bestLeg.bookmaker,
          recommendedOdds: side === "home" ? bestLeg.homeOdds : bestLeg.awayOdds,
          recommendedSide: side,
          deepLink: bestLeg.deepLink ?? null,
          polymarketAvailable,
        };
      }),
    );

    return NextResponse.json({
      fixtures: rows,
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
          : "Unable to fetch odds fixtures.",
    });
  }
}

