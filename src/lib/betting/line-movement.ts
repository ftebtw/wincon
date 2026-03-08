import { oddsClient, type OddsMovement } from "@/lib/betting/odds-api";

export interface LineMovement {
  fixture: string;
  bookmaker: string;
  timestamp: string;
  oldHomeOdds: number;
  newHomeOdds: number;
  oldAwayOdds: number;
  newAwayOdds: number;
  change: number;
  hasPublicNews: boolean;
  isReverseLine: boolean;
  volume: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toEpoch(timestamp: string): number {
  return new Date(timestamp).getTime();
}

function summarizeDirection(values: LineMovement[]): "home" | "away" | "mixed" {
  let home = 0;
  let away = 0;

  for (const row of values) {
    if (row.newHomeOdds < row.oldHomeOdds) {
      home += 1;
    } else if (row.newHomeOdds > row.oldHomeOdds) {
      away += 1;
    }
  }

  if (home > away) {
    return "home";
  }
  if (away > home) {
    return "away";
  }
  return "mixed";
}

export class LineMovementTracker {
  async trackMovements(fixtureId: string): Promise<LineMovement[]> {
    const history = await oddsClient.getHistoricalOdds(fixtureId).catch(() => []);
    return history.map((row) => this.mapOddsMovement(row));
  }

  detectSteamMove(movements: LineMovement[]): {
    detected: boolean;
    direction: "home" | "away";
    magnitude: number;
    bookmakers: string[];
    timestamp: string;
  } {
    if (movements.length < 3) {
      return {
        detected: false,
        direction: "home",
        magnitude: 0,
        bookmakers: [],
        timestamp: new Date().toISOString(),
      };
    }

    const sorted = [...movements].sort((a, b) => toEpoch(a.timestamp) - toEpoch(b.timestamp));
    const latestTs = toEpoch(sorted[sorted.length - 1].timestamp);
    const windowStart = latestTs - 10 * 60 * 1000;
    const inWindow = sorted.filter((row) => toEpoch(row.timestamp) >= windowStart);

    const direction = summarizeDirection(inWindow);
    const relevant = inWindow.filter((row) =>
      direction === "home"
        ? row.newHomeOdds < row.oldHomeOdds
        : direction === "away"
          ? row.newHomeOdds > row.oldHomeOdds
          : false,
    );

    const uniqueBooks = [...new Set(relevant.map((row) => row.bookmaker))];
    const magnitude = relevant.length
      ? relevant.reduce((sum, row) => sum + Math.abs(row.change), 0) / relevant.length
      : 0;

    const detected = direction !== "mixed" && uniqueBooks.length >= 3 && magnitude >= 0.05;
    return {
      detected,
      direction: direction === "mixed" ? "home" : direction,
      magnitude,
      bookmakers: uniqueBooks,
      timestamp: sorted[sorted.length - 1].timestamp,
    };
  }

  detectReverseLineMovement(movements: LineMovement[]): {
    detected: boolean;
    publicSide: "home" | "away";
    sharpSide: "home" | "away";
    confidence: number;
  } {
    if (movements.length < 4) {
      return {
        detected: false,
        publicSide: "home",
        sharpSide: "home",
        confidence: 0,
      };
    }

    const direction = summarizeDirection(movements);
    if (direction === "mixed") {
      return {
        detected: false,
        publicSide: "home",
        sharpSide: "home",
        confidence: 0,
      };
    }

    // Heuristic: if price moves to one side while consensus line already
    // implies the opposite side is popular, treat as reverse line movement.
    const latest = movements[movements.length - 1];
    const impliedHomeBefore = 1 / Math.max(latest.oldHomeOdds, 1.0001);
    const impliedAwayBefore = 1 / Math.max(latest.oldAwayOdds, 1.0001);
    const popularSide = impliedHomeBefore >= impliedAwayBefore ? "home" : "away";
    const sharpSide = direction;
    const detected = popularSide !== sharpSide && Math.abs(latest.change) >= 0.03;

    return {
      detected,
      publicSide: popularSide,
      sharpSide,
      confidence: detected ? clamp(Math.abs(latest.change) * 3.2, 0.2, 0.9) : 0,
    };
  }

  getLineMovementAdjustment(movements: LineMovement[]): {
    team1Adjustment: number;
    team2Adjustment: number;
    reason: string;
  } {
    const steam = this.detectSteamMove(movements);
    const rlm = this.detectReverseLineMovement(movements);

    let team1Adjustment = 0;
    let reason = "No significant sharp line movement.";

    if (steam.detected) {
      const delta = clamp(steam.magnitude * 0.4, 0.01, 0.03);
      team1Adjustment += steam.direction === "home" ? delta : -delta;
      reason = `Steam move detected on ${steam.direction} across ${steam.bookmakers.length} books.`;
    }

    if (rlm.detected) {
      const delta = clamp(rlm.confidence * 0.02, 0.008, 0.02);
      team1Adjustment += rlm.sharpSide === "home" ? delta : -delta;
      reason = `${reason} Reverse line movement suggests sharp support for ${rlm.sharpSide}.`;
    }

    team1Adjustment = clamp(team1Adjustment, -0.05, 0.05);

    return {
      team1Adjustment,
      team2Adjustment: -team1Adjustment,
      reason,
    };
  }

  private mapOddsMovement(row: OddsMovement): LineMovement {
    return {
      fixture: row.fixture.id,
      bookmaker: row.bookmaker,
      timestamp: row.timestamp,
      oldHomeOdds: row.previousHomeOdds,
      newHomeOdds: row.currentHomeOdds,
      oldAwayOdds: row.previousAwayOdds,
      newAwayOdds: row.currentAwayOdds,
      change: row.previousHomeOdds - row.currentHomeOdds,
      hasPublicNews: false,
      isReverseLine: false,
      volume: clamp(row.magnitude * 100_000, 0, 1_000_000),
    };
  }
}

export const lineMovementTracker = new LineMovementTracker();
