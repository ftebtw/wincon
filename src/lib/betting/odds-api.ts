const ODDSPAPI_BASE = "https://api.oddspapi.io/v4";

export const LOL_SPORT_ID = "league-of-legends";

export const MARKETS = {
  MATCH_WINNER: 171,
  MAP_1_WINNER: 173,
  MAP_2_WINNER: 175,
  MAP_3_WINNER: 177,
  MAP_HANDICAP: 178,
  TOTAL_MAPS: 179,
} as const;

const DEFAULT_SHARP_BOOKS = ["pinnacle", "betfair_exchange"];
const DEFAULT_ESPORTS_SPECIALISTS = ["ggbet", "thunderpick", "betway", "rivalry", "unikrn"];

const DEFAULT_REFRESH_MS = 2 * 60 * 1000;

export interface OddsFixture {
  id: string;
  sportId: string;
  league: string;
  startTime: string;
  status: "pre" | "live" | "ended";
  homeTeam: string;
  awayTeam: string;
  scores?: { home: number; away: number };
}

export interface BookmakerOdds {
  bookmaker: string;
  homeOdds: number;
  awayOdds: number;
  homeImpliedProb: number;
  awayImpliedProb: number;
  margin: number;
  lastUpdated: string;
  deepLink?: string;
}

export interface FixtureOdds {
  fixture: OddsFixture;
  market: string;
  bookmakers: BookmakerOdds[];
  bestHomeOdds: BookmakerOdds;
  bestAwayOdds: BookmakerOdds;
  pinnacleOdds?: BookmakerOdds;
  consensusProb: {
    home: number;
    away: number;
  };
}

export interface OddsMovement {
  fixture: OddsFixture;
  bookmaker: string;
  timestamp: string;
  previousHomeOdds: number;
  currentHomeOdds: number;
  previousAwayOdds: number;
  currentAwayOdds: number;
  direction: "home_shortening" | "away_shortening" | "stable";
  magnitude: number;
}

export interface BestOddsResult {
  bestHome: BookmakerOdds;
  bestAway: BookmakerOdds;
  allBookmakers: BookmakerOdds[];
  pinnacle: BookmakerOdds | null;
  arbitrageExists: boolean;
  arbitragePercent?: number;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

function normalizeBookmaker(value: unknown): string {
  return String(value ?? "unknown")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function parseBookList(raw: string | undefined, fallback: string[]): string[] {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(",")
    .map((entry) => normalizeBookmaker(entry))
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : fallback;
}

export class OddsPapiClient {
  private apiKey: string;
  private cache = new Map<string, { data: unknown; expiresAt: number }>();
  private sharpBooks = parseBookList(process.env.ODDS_SHARP_BOOKS, DEFAULT_SHARP_BOOKS);
  private esportsBooks = parseBookList(process.env.ODDS_ESPORTS_BOOKS, DEFAULT_ESPORTS_SPECIALISTS);
  private refreshMs = Math.max(15_000, toNumber(process.env.ODDS_REFRESH_INTERVAL, DEFAULT_REFRESH_MS));

  constructor() {
    this.apiKey = process.env.ODDSPAPI_API_KEY || "";
  }

  private async fetch(endpoint: string, params?: Record<string, string>): Promise<unknown> {
    if (!this.apiKey) {
      throw new Error("ODDSPAPI_API_KEY is not configured.");
    }

    const url = new URL(`${ODDSPAPI_BASE}${endpoint}`);
    url.searchParams.set("apiKey", this.apiKey);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const cacheKey = url.toString();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`OddsPapi error: ${response.status}`);
    }

    const data = await response.json();
    this.cache.set(cacheKey, {
      data,
      expiresAt: Date.now() + this.refreshMs,
    });

    return data;
  }

  async getUpcomingFixtures(): Promise<FixtureOdds[]> {
    const data = await this.fetch(`/sports/${LOL_SPORT_ID}/odds`, {
      markets: String(MARKETS.MATCH_WINNER),
      oddsFormat: "decimal",
    });

    return this.parseFixtureOdds(data);
  }

  async getFixtureOdds(fixtureId: string): Promise<FixtureOdds> {
    const data = await this.fetch(`/fixtures/${fixtureId}/odds`, {
      markets: Object.values(MARKETS).join(","),
      oddsFormat: "decimal",
    });

    const parsed = this.parseFixtureOdds(data);
    const first = parsed[0];
    if (!first) {
      throw new Error(`No odds returned for fixture ${fixtureId}.`);
    }
    return first;
  }

  async getLiveOdds(): Promise<FixtureOdds[]> {
    const data = await this.fetch(`/sports/${LOL_SPORT_ID}/odds/live`, {
      markets: String(MARKETS.MATCH_WINNER),
      oddsFormat: "decimal",
    });

    return this.parseFixtureOdds(data);
  }

  async getHistoricalOdds(fixtureId: string): Promise<OddsMovement[]> {
    const data = await this.fetch(`/fixtures/${fixtureId}/odds/history`, {
      oddsFormat: "decimal",
    });

    return this.parseOddsHistory(data);
  }

  async getBestOdds(fixtureId: string): Promise<BestOddsResult> {
    const odds = await this.getFixtureOdds(fixtureId);
    return this.summarizeBestOdds(odds);
  }

  summarizeBestOdds(odds: FixtureOdds): BestOddsResult {
    const bestHome = odds.bookmakers.reduce((best, current) =>
      current.homeOdds > best.homeOdds ? current : best,
    );

    const bestAway = odds.bookmakers.reduce((best, current) =>
      current.awayOdds > best.awayOdds ? current : best,
    );

    const pinnacle =
      odds.bookmakers.find((entry) => this.sharpBooks.includes(entry.bookmaker)) ?? null;

    const totalImplied = (1 / bestHome.homeOdds) + (1 / bestAway.awayOdds);
    const arbitrageExists = totalImplied < 1;

    return {
      bestHome,
      bestAway,
      allBookmakers: odds.bookmakers,
      pinnacle,
      arbitrageExists,
      arbitragePercent: arbitrageExists ? (1 - totalImplied) * 100 : undefined,
    };
  }

  removeVig(homeOdds: number, awayOdds: number): { home: number; away: number } {
    const homeImplied = 1 / Math.max(homeOdds, 1.0001);
    const awayImplied = 1 / Math.max(awayOdds, 1.0001);
    const total = homeImplied + awayImplied;

    if (total <= 0) {
      return { home: 0.5, away: 0.5 };
    }

    return {
      home: homeImplied / total,
      away: awayImplied / total,
    };
  }

  private parseFixtureOdds(data: unknown): FixtureOdds[] {
    const payload = data as
      | { data?: unknown[]; fixtures?: unknown[]; odds?: unknown[] }
      | unknown[]
      | null
      | undefined;

    const fixtures = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.fixtures)
          ? payload.fixtures
          : Array.isArray(payload?.odds)
            ? payload.odds
            : [];

    const parsed: FixtureOdds[] = [];

    for (const row of fixtures) {
      const entry = row as Record<string, unknown>;
      const fixture = this.parseFixture(entry);
      if (!fixture) {
        continue;
      }
      const bookmakers = this.parseBookmakers(entry, fixture);
      if (bookmakers.length === 0) {
        continue;
      }

      const filtered = bookmakers.filter((book) => {
        return this.sharpBooks.includes(book.bookmaker) || this.esportsBooks.includes(book.bookmaker) || book.bookmaker === "polymarket" || book.bookmaker === "betfair_exchange" || book.bookmaker === "pinnacle";
      });

      const activeBooks = filtered.length > 0 ? filtered : bookmakers;

      const bestHome = activeBooks.reduce((best, current) =>
        current.homeOdds > best.homeOdds ? current : best,
      );
      const bestAway = activeBooks.reduce((best, current) =>
        current.awayOdds > best.awayOdds ? current : best,
      );

      const consensus = activeBooks.map((book) => this.removeVig(book.homeOdds, book.awayOdds));
      const consensusProb = consensus.length > 0
        ? {
            home: consensus.reduce((sum, item) => sum + item.home, 0) / consensus.length,
            away: consensus.reduce((sum, item) => sum + item.away, 0) / consensus.length,
          }
        : { home: 0.5, away: 0.5 };

      const pinnacle = activeBooks.find((book) => this.sharpBooks.includes(book.bookmaker));

      parsed.push({
        fixture,
        market: "Match Winner",
        bookmakers: activeBooks,
        bestHomeOdds: bestHome,
        bestAwayOdds: bestAway,
        pinnacleOdds: pinnacle,
        consensusProb,
      });
    }

    return parsed;
  }

  private parseFixture(entry: Record<string, unknown>): OddsFixture | null {
    const id = String(entry.id ?? entry.fixtureId ?? entry.fixture_id ?? "").trim();
    if (!id) {
      return null;
    }

    const league =
      String(
        (entry.league as Record<string, unknown> | undefined)?.name ??
          entry.league_name ??
          entry.tournament ??
          entry.competition ??
          "",
      ) || "Unknown";

    const homeTeam =
      String(
        (entry.home as Record<string, unknown> | undefined)?.name ??
          (entry.homeTeam as Record<string, unknown> | undefined)?.name ??
          entry.home_name ??
          entry.homeTeam ??
          entry.team1 ??
          "",
      ).trim() || "Home";

    const awayTeam =
      String(
        (entry.away as Record<string, unknown> | undefined)?.name ??
          (entry.awayTeam as Record<string, unknown> | undefined)?.name ??
          entry.away_name ??
          entry.awayTeam ??
          entry.team2 ??
          "",
      ).trim() || "Away";

    const statusRaw = String(entry.status ?? entry.state ?? "pre").toLowerCase();
    const status: OddsFixture["status"] =
      statusRaw.includes("live") || statusRaw.includes("inprogress")
        ? "live"
        : statusRaw.includes("end") || statusRaw.includes("final")
          ? "ended"
          : "pre";

    const scoreRoot = (entry.scores as Record<string, unknown> | undefined) ?? {};

    const homeScore = toNumber(scoreRoot.home ?? entry.home_score, NaN);
    const awayScore = toNumber(scoreRoot.away ?? entry.away_score, NaN);

    return {
      id,
      sportId: String(entry.sportId ?? entry.sport_id ?? LOL_SPORT_ID),
      league,
      startTime: toIso(entry.startTime ?? entry.start_time ?? entry.commence_time ?? Date.now()),
      status,
      homeTeam,
      awayTeam,
      scores: Number.isFinite(homeScore) && Number.isFinite(awayScore)
        ? { home: homeScore, away: awayScore }
        : undefined,
    };
  }

  private parseBookmakers(entry: Record<string, unknown>, fixture: OddsFixture): BookmakerOdds[] {
    const rows = Array.isArray(entry.bookmakers)
      ? entry.bookmakers
      : Array.isArray(entry.odds)
        ? entry.odds
        : Array.isArray((entry.markets as Record<string, unknown> | undefined)?.bookmakers)
          ? ((entry.markets as Record<string, unknown>).bookmakers as unknown[])
          : [];

    const books: BookmakerOdds[] = [];

    for (const bookmakerRow of rows) {
      const bookmakerEntry = bookmakerRow as Record<string, unknown>;
      const bookmaker = normalizeBookmaker(
        bookmakerEntry.key ?? bookmakerEntry.slug ?? bookmakerEntry.name ?? bookmakerEntry.bookmaker,
      );

      const outcomes = this.extractOutcomeOdds(bookmakerEntry, fixture);
      if (!outcomes) {
        continue;
      }

      const homeOdds = clamp(outcomes.home, 1.01, 1000);
      const awayOdds = clamp(outcomes.away, 1.01, 1000);
      const homeImpliedProb = 1 / homeOdds;
      const awayImpliedProb = 1 / awayOdds;

      books.push({
        bookmaker,
        homeOdds,
        awayOdds,
        homeImpliedProb,
        awayImpliedProb,
        margin: homeImpliedProb + awayImpliedProb - 1,
        lastUpdated: toIso(
          bookmakerEntry.updatedAt ?? bookmakerEntry.updated_at ?? entry.updatedAt ?? Date.now(),
        ),
        deepLink: String(bookmakerEntry.link ?? bookmakerEntry.url ?? bookmakerEntry.deepLink ?? "") || undefined,
      });
    }

    return books;
  }

  private extractOutcomeOdds(bookmakerEntry: Record<string, unknown>, fixture: OddsFixture): { home: number; away: number } | null {
    const directHome = toNumber(bookmakerEntry.homeOdds ?? bookmakerEntry.home_odds, NaN);
    const directAway = toNumber(bookmakerEntry.awayOdds ?? bookmakerEntry.away_odds, NaN);
    if (Number.isFinite(directHome) && Number.isFinite(directAway)) {
      return { home: directHome, away: directAway };
    }

    const markets = Array.isArray(bookmakerEntry.markets)
      ? bookmakerEntry.markets
      : Array.isArray(bookmakerEntry.market)
        ? (bookmakerEntry.market as unknown[])
        : [];

    for (const marketRow of markets) {
      const market = marketRow as Record<string, unknown>;
      const marketId = toNumber(market.id ?? market.market_id, 0);
      if (marketId !== 0 && marketId !== MARKETS.MATCH_WINNER) {
        continue;
      }

      const outcomes = Array.isArray(market.outcomes)
        ? market.outcomes
        : Array.isArray(market.selections)
          ? (market.selections as unknown[])
          : [];

      const mapped = this.mapOutcomeArray(outcomes, fixture);
      if (mapped) {
        return mapped;
      }
    }

    const fallbackOutcomes = Array.isArray(bookmakerEntry.outcomes)
      ? bookmakerEntry.outcomes
      : Array.isArray(bookmakerEntry.selections)
        ? (bookmakerEntry.selections as unknown[])
        : [];

    return this.mapOutcomeArray(fallbackOutcomes, fixture);
  }

  private mapOutcomeArray(outcomes: unknown[], fixture: OddsFixture): { home: number; away: number } | null {
    let homeOdds: number | null = null;
    let awayOdds: number | null = null;

    for (const row of outcomes) {
      const outcome = row as Record<string, unknown>;
      const name = String(outcome.name ?? outcome.label ?? outcome.participant ?? "").toLowerCase();
      const price = toNumber(outcome.price ?? outcome.odds ?? outcome.decimal, NaN);
      if (!Number.isFinite(price)) {
        continue;
      }

      const isHome =
        name === "home" ||
        name.includes(fixture.homeTeam.toLowerCase()) ||
        name.includes("team 1") ||
        name === "1";
      const isAway =
        name === "away" ||
        name.includes(fixture.awayTeam.toLowerCase()) ||
        name.includes("team 2") ||
        name === "2";

      if (isHome) {
        homeOdds = price;
      }
      if (isAway) {
        awayOdds = price;
      }
    }

    if (homeOdds !== null && awayOdds !== null) {
      return { home: homeOdds, away: awayOdds };
    }

    if (outcomes.length >= 2) {
      const first = outcomes[0] as Record<string, unknown>;
      const second = outcomes[1] as Record<string, unknown>;
      const firstPrice = toNumber(first.price ?? first.odds ?? first.decimal, NaN);
      const secondPrice = toNumber(second.price ?? second.odds ?? second.decimal, NaN);
      if (Number.isFinite(firstPrice) && Number.isFinite(secondPrice)) {
        return { home: firstPrice, away: secondPrice };
      }
    }

    return null;
  }

  private parseOddsHistory(data: unknown): OddsMovement[] {
    const payload = data as
      | { data?: unknown[]; history?: unknown[]; odds_history?: unknown[] }
      | unknown[]
      | null
      | undefined;

    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.history)
          ? payload.history
          : Array.isArray(payload?.odds_history)
            ? payload.odds_history
            : [];

    const movement: OddsMovement[] = [];

    for (const row of rows) {
      const entry = row as Record<string, unknown>;
      const fixture = this.parseFixture(entry) ?? {
        id: String(entry.fixtureId ?? entry.fixture_id ?? "unknown"),
        sportId: LOL_SPORT_ID,
        league: String(entry.league ?? "Unknown"),
        startTime: toIso(entry.startTime ?? Date.now()),
        status: "pre",
        homeTeam: String(entry.homeTeam ?? entry.home ?? "Home"),
        awayTeam: String(entry.awayTeam ?? entry.away ?? "Away"),
      };

      const snapshots = Array.isArray(entry.snapshots)
        ? entry.snapshots
        : Array.isArray(entry.odds)
          ? entry.odds
          : [];

      const previousByBook = new Map<string, { home: number; away: number; ts: string }>();

      for (const snap of snapshots) {
        const snapEntry = snap as Record<string, unknown>;
        const bookmaker = normalizeBookmaker(
          snapEntry.bookmaker ?? snapEntry.key ?? snapEntry.name,
        );

        const home = toNumber(snapEntry.homeOdds ?? snapEntry.home_odds, NaN);
        const away = toNumber(snapEntry.awayOdds ?? snapEntry.away_odds, NaN);
        if (!Number.isFinite(home) || !Number.isFinite(away)) {
          continue;
        }

        const ts = toIso(snapEntry.timestamp ?? snapEntry.updatedAt ?? Date.now());
        const previous = previousByBook.get(bookmaker);
        if (!previous) {
          previousByBook.set(bookmaker, { home, away, ts });
          continue;
        }

        const homeMove = previous.home - home;
        const awayMove = previous.away - away;
        const magnitude = Math.max(Math.abs(homeMove), Math.abs(awayMove));

        const direction: OddsMovement["direction"] =
          magnitude < 0.005
            ? "stable"
            : homeMove > awayMove
              ? "home_shortening"
              : "away_shortening";

        movement.push({
          fixture,
          bookmaker,
          timestamp: ts,
          previousHomeOdds: previous.home,
          currentHomeOdds: home,
          previousAwayOdds: previous.away,
          currentAwayOdds: away,
          direction,
          magnitude,
        });

        previousByBook.set(bookmaker, { home, away, ts });
      }
    }

    return movement.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }
}

export const oddsClient = new OddsPapiClient();

