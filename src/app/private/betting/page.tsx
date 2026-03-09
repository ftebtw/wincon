import type { Metadata } from "next";
import { desc } from "drizzle-orm";

import { PrivateOddsBoard } from "@/components/PrivateOddsBoard";
import { PrivateBettingControls } from "@/components/PrivateBettingControls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAutoBettorConfigFromEnv } from "@/lib/betting/auto-bettor";
import { liveGameModel, type LiveGameState } from "@/lib/betting/live-game-model";
import { oddsClient } from "@/lib/betting/odds-api";
import { PolymarketClient } from "@/lib/betting/polymarket";
import { PredictionModel } from "@/lib/betting/prediction-model";
import { soloQueueSpy } from "@/lib/betting/solo-queue-spy";
import { db, schema } from "@/lib/db";
import { esportsAPIClient, isEsportsLiveEnabled } from "@/lib/esports-api";

export const metadata: Metadata = {
  title: "Private Betting Dashboard",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function safeQuery<T>(label: string, query: Promise<T>, fallback: T): Promise<T> {
  try {
    return await query;
  } catch (error) {
    console.error(`[PrivateBettingPage] ${label} query failed:`, error);
    return fallback;
  }
}

export default async function PrivateBettingPage() {
  const config = getAutoBettorConfigFromEnv();
  const polymarket = new PolymarketClient();
  const model = new PredictionModel();
  const refreshIntervalMs = Math.max(
    15_000,
    Number(process.env.ODDS_REFRESH_INTERVAL ?? 120_000),
  );

  const [predictionRows, logRows, backtestRows] = await Promise.all([
    safeQuery(
      "betting_predictions",
      db
        .select()
        .from(schema.bettingPredictions)
        .orderBy(desc(schema.bettingPredictions.createdAt))
        .limit(20),
      [],
    ),
    safeQuery(
      "betting_log",
      db
        .select()
        .from(schema.bettingLog)
        .orderBy(desc(schema.bettingLog.createdAt))
        .limit(25),
      [],
    ),
    safeQuery(
      "backtest_results",
      db
        .select()
        .from(schema.backtestResults)
        .orderBy(desc(schema.backtestResults.runAt))
        .limit(5),
      [],
    ),
  ]);

  const [portfolio] = await Promise.all([
    polymarket.getPortfolio().catch(() => ({
      openBets: [],
      totalInvested: 0,
      totalPnl: 0,
      roi: 0,
    })),
  ]);

  const [upcomingOdds, liveOdds, liveFeed] = await Promise.all([
    oddsClient.getUpcomingFixtures().catch(() => []),
    oddsClient.getLiveOdds().catch(() => []),
    isEsportsLiveEnabled()
      ? esportsAPIClient.getLive().catch(() => ({ events: [], games: [] }))
      : Promise.resolve({ events: [], games: [] }),
  ]);

  const primaryUpcoming = upcomingOdds[0] ?? null;
  const soloSpyPanel = primaryUpcoming
    ? await (async () => {
        const team1 = primaryUpcoming.fixture.homeTeam;
        const team2 = primaryUpcoming.fixture.awayTeam;
        const [spySignals, baselinePrediction, spyPrediction] = await Promise.all([
          soloQueueSpy.scanMatchPractice(team1, team2).catch(() => null),
          model.predict({
            team1,
            team2,
            league: primaryUpcoming.fixture.league,
            side: { team1: "blue" },
            includeEdgeSignals: true,
            fixtureId: primaryUpcoming.fixture.id,
            featureToggles: { solo_queue_spy: false },
          }),
          model.predict({
            team1,
            team2,
            league: primaryUpcoming.fixture.league,
            side: { team1: "blue" },
            includeEdgeSignals: true,
            fixtureId: primaryUpcoming.fixture.id,
          }),
        ]);

        return {
          fixture: primaryUpcoming.fixture,
          spySignals,
          baselinePrediction,
          spyPrediction,
        };
      })().catch(() => null)
    : null;

  const livePanel = liveFeed.games[0]
    ? await (async () => {
        const game = liveFeed.games[0];
        const state: LiveGameState = {
          timestamp: toNumber(game.clock.totalSeconds, 0),
          team1Gold: toNumber(game.teams[0]?.gold, 0),
          team2Gold: toNumber(game.teams[1]?.gold, 0),
          goldDiff: toNumber(game.teams[0]?.gold, 0) - toNumber(game.teams[1]?.gold, 0),
          team1Dragons: game.teams[0]?.dragons?.length ?? 0,
          team2Dragons: game.teams[1]?.dragons?.length ?? 0,
          team1Towers: toNumber(game.teams[0]?.towers, 0),
          team2Towers: toNumber(game.teams[1]?.towers, 0),
          team1Barons: toNumber(game.teams[0]?.barons, 0),
          team2Barons: toNumber(game.teams[1]?.barons, 0),
          team1Heralds: 0,
          team2Heralds: 0,
          team1DragonSoul: (game.teams[0]?.dragons?.length ?? 0) >= 4,
          elderDragonActive: false,
          roleGoldDiff: {
            top: 0,
            jungle: 0,
            mid: 0,
            adc: 0,
            support: toNumber(game.teams[0]?.gold, 0) - toNumber(game.teams[1]?.gold, 0),
          },
          team1Kills: toNumber(game.teams[0]?.kills, 0),
          team2Kills: toNumber(game.teams[1]?.kills, 0),
        };

        const modelResult = await liveGameModel.predictLive(state, [], [], [], []);
        const matchOdds = liveOdds.find((fixture) => {
          const home = normalizeText(fixture.fixture.homeTeam);
          const away = normalizeText(fixture.fixture.awayTeam);
          const t1 = normalizeText(game.teams[0]?.name ?? "");
          const t2 = normalizeText(game.teams[1]?.name ?? "");
          return (home.includes(t1) && away.includes(t2)) || (home.includes(t2) && away.includes(t1));
        });

        const marketProb = matchOdds
          ? oddsClient.removeVig(
              matchOdds.bestHomeOdds.homeOdds,
              matchOdds.bestAwayOdds.awayOdds,
            )
          : null;
        const edge = marketProb ? modelResult.team1WinProb - marketProb.home : null;

        return {
          game,
          modelResult,
          marketProb,
          edge,
          odds: matchOdds,
        };
      })().catch(() => null)
    : null;

  const resolvedBets = logRows.filter((row) => row.status === "won" || row.status === "lost");
  const highEdgeLogs = logRows.filter((row) => toNumber(row.edge, 0) >= config.minEdge);
  const highEdgeWins = resolvedBets.filter((row) => row.status === "won" && toNumber(row.edge, 0) >= config.minEdge).length;
  const highEdgeAccuracy = resolvedBets.length > 0
    ? highEdgeWins / Math.max(1, resolvedBets.filter((row) => toNumber(row.edge, 0) >= config.minEdge).length)
    : 0;

  const latestBacktest = backtestRows[0];
  const backtestResult = (latestBacktest?.results ?? null) as
    | {
        calibration?: Array<{ bucket: string; predictedProb: number; actualWinRate: number; sampleSize: number }>;
        featureImportance?: Array<{ feature: string; importance: number }>;
        bettingSimulation?: { finalBankroll?: number; roi?: number; maxDrawdown?: number };
      }
    | null;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Private Esports Betting Dashboard</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant={config.enabled ? "default" : "outline"}>
                {config.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Badge variant={config.dryRun ? "secondary" : "destructive"}>
                {config.dryRun ? "Dry Run" : "Live Bets"}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <PrivateBettingControls initialDryRun={config.dryRun} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm text-muted-foreground">
            <p>Bankroll: {usd(config.bankroll)}</p>
            <p>Min Edge: {pct(config.minEdge)}</p>
            <p>Max Bet Fraction: {pct(config.maxBetFraction)}</p>
            <p>Daily Limits: {config.maxDailyBets} bets / {usd(config.maxDailyLoss)} loss</p>
          </div>
        </CardContent>
      </Card>

      <PrivateOddsBoard refreshIntervalMs={refreshIntervalMs} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Solo Queue Spy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            {soloSpyPanel ? (
              <>
                <p className="text-foreground font-medium">
                  {soloSpyPanel.fixture.homeTeam} vs {soloSpyPanel.fixture.awayTeam} ({soloSpyPanel.fixture.league})
                </p>
                <p>
                  Pre-draft with spy: {pct(soloSpyPanel.spyPrediction.team1WinProb)} vs baseline {pct(soloSpyPanel.baselinePrediction.team1WinProb)}
                </p>
                <p>
                  Spy edge shift: {((soloSpyPanel.spyPrediction.team1WinProb - soloSpyPanel.baselinePrediction.team1WinProb) * 100).toFixed(1)}%
                </p>
                <div className="space-y-1">
                  <p className="font-semibold text-foreground">Top practice signals</p>
                  {(soloSpyPanel.spySignals?.team1 ?? []).slice(0, 3).map((signal) => (
                    <p key={`${signal.player}-${signal.champion}`}>
                      {signal.player}: {signal.champion} x{signal.gamesLast3Days} ({(signal.confidenceScore * 100).toFixed(0)}% conf)
                    </p>
                  ))}
                  {(soloSpyPanel.spySignals?.team2 ?? []).slice(0, 2).map((signal) => (
                    <p key={`${signal.player}-${signal.champion}`}>
                      {signal.player}: {signal.champion} x{signal.gamesLast3Days} ({(signal.confidenceScore * 100).toFixed(0)}% conf)
                    </p>
                  ))}
                  {soloSpyPanel.spySignals === null ? <p>No solo queue spy data available.</p> : null}
                </div>
              </>
            ) : (
              <p>No upcoming fixture available for solo queue spy panel.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Live In-Game Betting Model</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            {livePanel ? (
              <>
                <p className="text-foreground font-medium">
                  {livePanel.game.teams[0]?.name} vs {livePanel.game.teams[1]?.name} — {Math.floor((livePanel.game.clock.totalSeconds ?? 0) / 60)}:{String((livePanel.game.clock.totalSeconds ?? 0) % 60).padStart(2, "0")}
                </p>
                <p>
                  Gold: {livePanel.game.teams[0]?.gold?.toLocaleString()} vs {livePanel.game.teams[1]?.gold?.toLocaleString()} | Kills: {livePanel.game.teams[0]?.kills} vs {livePanel.game.teams[1]?.kills}
                </p>
                <p>Model: {pct(livePanel.modelResult.team1WinProb)} / {pct(1 - livePanel.modelResult.team1WinProb)}</p>
                <p>
                  Market: {livePanel.marketProb ? `${pct(livePanel.marketProb.home)} / ${pct(livePanel.marketProb.away)}` : "n/a"}
                </p>
                <p className={livePanel.edge !== null && Math.abs(livePanel.edge) >= 0.05 ? "text-[#34d399]" : ""}>
                  Edge: {livePanel.edge !== null ? `${(livePanel.edge * 100).toFixed(1)}%` : "n/a"}
                </p>
                <div className="space-y-1">
                  {livePanel.modelResult.factors.slice(0, 4).map((factor) => (
                    <p key={factor}>{factor}</p>
                  ))}
                </div>
              </>
            ) : (
              <p>No live pro game available for live in-game model.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Live Draft Tracker</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Draft progression updates are available through the model&apos;s
              `updateWithDraftAction()` flow.
            </p>
            <p>
              During draft, feed each pick/ban action and record probability
              deltas to trigger manual or automated bet entries.
            </p>
            <p>
              Current status: waiting for live draft event feed integration.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Portfolio</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>Total invested: {usd(portfolio.totalInvested)}</p>
            <p>Total P&amp;L: {usd(portfolio.totalPnl)}</p>
            <p>ROI: {pct(portfolio.roi)}</p>
            <div className="space-y-2">
              {portfolio.openBets.slice(0, 8).map((bet) => (
                <div key={`${bet.market}-${bet.side}`} className="rounded border border-border/60 p-2">
                  <p className="font-medium text-foreground">{bet.market}</p>
                  <p>Side: {bet.side} | Amount: {usd(bet.amount)} | Mark: {bet.currentPrice.toFixed(3)} | P&amp;L: {usd(bet.pnl)}</p>
                </div>
              ))}
              {portfolio.openBets.length === 0 ? <p>No open bets.</p> : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Backtest Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            {latestBacktest ? (
              <>
                <p>Accuracy: {pct(toNumber(latestBacktest.accuracy, 0))}</p>
                <p>ROI: {pct(toNumber(latestBacktest.roi, 0))}</p>
                <p>Total Matches: {toNumber(latestBacktest.totalMatches, 0)}</p>
                {backtestResult?.bettingSimulation ? (
                  <>
                    <p>Final bankroll: {usd(toNumber(backtestResult.bettingSimulation.finalBankroll, 0))}</p>
                    <p>Max drawdown: {usd(toNumber(backtestResult.bettingSimulation.maxDrawdown, 0))}</p>
                  </>
                ) : null}
                <div className="space-y-1">
                  <p className="font-semibold text-foreground">Calibration</p>
                  {(backtestResult?.calibration ?? []).slice(0, 6).map((row) => (
                    <p key={row.bucket}>{row.bucket}: predicted {pct(row.predictedProb)} / actual {pct(row.actualWinRate)} ({row.sampleSize} games)</p>
                  ))}
                </div>
              </>
            ) : (
              <p>No backtest runs stored yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Model vs Market Tracker</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
          <p>Logged opportunities: {logRows.length}</p>
          <p>High-edge opportunities (&ge; {pct(config.minEdge)}): {highEdgeLogs.length}</p>
          <p>Resolved bets tracked: {resolvedBets.length}</p>
          <p>
            High-edge realized hit rate: {resolvedBets.length > 0 ? pct(highEdgeAccuracy) : "n/a"}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
          <p>Auto-betting: {config.enabled ? "enabled" : "disabled"}</p>
          <p>Dry run: {config.dryRun ? "on" : "off"}</p>
          <p>Sizing mode: {config.betSizing}</p>
          <p>Bankroll: {usd(config.bankroll)}</p>
          <p>Min edge threshold: {pct(config.minEdge)}</p>
          <p>Max bet fraction: {pct(config.maxBetFraction)}</p>
          <p>Max daily bets: {config.maxDailyBets}</p>
          <p>Max daily loss: {usd(config.maxDailyLoss)}</p>
          <p>Leagues: {config.leagues.join(", ")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Prediction History</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="px-2 py-2">Created</th>
                <th className="px-2 py-2">Match</th>
                <th className="px-2 py-2">League</th>
                <th className="px-2 py-2">Team1 Win Prob</th>
                <th className="px-2 py-2">Confidence</th>
                <th className="px-2 py-2">Actual</th>
              </tr>
            </thead>
            <tbody>
              {predictionRows.map((row) => (
                <tr key={row.id} className="border-b border-border/40">
                  <td className="px-2 py-2">{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
                  <td className="px-2 py-2">{row.team1} vs {row.team2}</td>
                  <td className="px-2 py-2">{row.league ?? "-"}</td>
                  <td className="px-2 py-2">{pct(toNumber(row.team1WinProb, 0))}</td>
                  <td className="px-2 py-2">{row.confidence ?? "-"}</td>
                  <td className="px-2 py-2">{row.actualResult ?? "pending"}</td>
                </tr>
              ))}
              {predictionRows.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-muted-foreground" colSpan={6}>
                    No predictions logged yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bet Log</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="px-2 py-2">Created</th>
                <th className="px-2 py-2">Market</th>
                <th className="px-2 py-2">Side</th>
                <th className="px-2 py-2">Edge</th>
                <th className="px-2 py-2">Amount</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {logRows.map((row) => (
                <tr key={row.id} className="border-b border-border/40">
                  <td className="px-2 py-2">{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
                  <td className="px-2 py-2">{row.marketId ?? "-"}</td>
                  <td className="px-2 py-2">{row.side ?? "-"}</td>
                  <td className="px-2 py-2">{pct(toNumber(row.edge, 0))}</td>
                  <td className="px-2 py-2">{usd(toNumber(row.betAmount, 0))}</td>
                  <td className="px-2 py-2">{row.status ?? "-"}</td>
                  <td className="px-2 py-2">{usd(toNumber(row.pnl, 0))}</td>
                </tr>
              ))}
              {logRows.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-muted-foreground" colSpan={7}>
                    No bets logged yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

