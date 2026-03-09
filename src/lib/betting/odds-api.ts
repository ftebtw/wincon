const ODDSPAPI_BASE = "https://api.oddspapi.io/v4";
const THE_ODDS_API_BASE = "https://api.the-odds-api.com/v4";

export const LOL_SPORT_ID = "esports_lol";

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

type OddsProvider = "theoddsapi" | "oddspapi";

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

function normalizeTeam(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
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

function getEventStatus(commenceTime: string, completed: unknown): OddsFixture["status"] {
  if (completed === true) {
    return "ended";
  }

  const start = new Date(commenceTime).getTime();
  if (!Number.isFinite(start)) {
    return "pre";
  }

  const now = Date.now();
  if (start <= now && now - start <= 6 * 60 * 60 * 1000) {
    return "live";
  }
  if (start < now - 6 * 60 * 60 * 1000) {
    return "ended";
  }
  return "pre";
}

export class OddsPapiClient {
  private oddsPapiKey: string;
  private theOddsApiKey: string;
  private provider: OddsProvider;
  private cache = new Map<string, { data: unknown; expiresAt: number }>();
  private sharpBooks = parseBookList(process.env.ODDS_SHARP_BOOKS, DEFAULT_SHARP_BOOKS);
  private esportsBooks = parseBookList(process.env.ODDS_ESPORTS_BOOKS, DEFAULT_ESPORTS_SPECIALISTS);
  private refreshMs = Math.max(15_000, toNumber(process.env.ODDS_REFRESH_INTERVAL, DEFAULT_REFRESH_MS));
  private theOddsSportKey: string | null = process.env.THE_ODDS_API_SPORT_KEY ?? null;
  private theOddsRegions = process.env.THE_ODDS_API_REGIONS ?? "us,uk,eu,au";

  constructor() {
    this.oddsPapiKey = process.env.ODDSPAPI_API_KEY || "";
    this.theOddsApiKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || "";

    const configuredProvider = (process.env.ODDS_PROVIDER ?? "").toLowerCase();
    if (configuredProvider === "theoddsapi") {
      this.provider = "theoddsapi";
    } else if (configuredProvider === "oddspapi") {
      this.provider = "oddspapi";
    } else {
      this.provider = this.theOddsApiKey ? "theoddsapi" : "oddspapi";
    }
  }

  private getCached(key: string): unknown | null {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return cached.data;
  }

  private setCached(key: string, data: unknown): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.refreshMs,
    });
  }

  private async fetchJson(url: URL, cacheKey: string): Promise<unknown> {
    const cached = this.getCached(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) {
      const payload = await response.text().catch(() => "");
      throw new Error(`Odds API error ${response.status}: ${payload.slice(0, 180)}`);
    }

    const data = await response.json();
    this.setCached(cacheKey, data);
    return data;
  }

  private async fetchFromTheOddsApi(path: string, params?: Record<string, string>): Promise<unknown> {
    if (!this.theOddsApiKey) {
      throw new Error("THE_ODDS_API_KEY is not configured.");
    }

    const url = new URL(`${THE_ODDS_API_BASE}${path}`);
    url.searchParams.set("apiKey", this.theOddsApiKey);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value) {
          url.searchParams.set(key, value);
        }
      }
    }

    return this.fetchJson(url, url.toString());
  }

  private async fetchFromOddsPapi(path: string, params?: Record<string, string>): Promise<unknown> {
    if (!this.oddsPapiKey) {
      throw new Error("ODDSPAPI_API_KEY is not configured.");
    }

    const url = new URL(`${ODDSPAPI_BASE}${path}`);
    url.searchParams.set("apiKey", this.oddsPapiKey);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value) {
          url.searchParams.set(key, value);
        }
      }
    }

    return this.fetchJson(url, url.toString());
  }

  private async resolveTheOddsSportKey(): Promise<string> {
    if (this.theOddsSportKey) {
      return this.theOddsSportKey;
    }

    const payload = await this.fetchFromTheOddsApi("/sports");
    const rows = Array.isArray(payload) ? payload : [];

    const match = rows.find((row) => {
      const entry = row as Record<string, unknown>;
      const key = String(entry.key ?? "").toLowerCase();
      const title = String(entry.title ?? "").toLowerCase();
      return (
        key.includes("league") ||
        key.includes("lol") ||
        title.includes("league of legends") ||
        title.includes("league-of-legends")
      );
    }) as Record<string, unknown> | undefined;

    if (!match) {
      throw new Error("Could not resolve League of Legends sport key from The Odds API.");
    }

    this.theOddsSportKey = String(match.key ?? LOL_SPORT_ID);
    return this.theOddsSportKey;
  }

  private parseTheOddsEvent(event: Record<string, unknown>): FixtureOdds | null {
    const fixture: OddsFixture = {
      id: String(event.id ?? "").trim(),
      sportId: String(event.sport_key ?? event.sportKey ?? LOL_SPORT_ID),
      league: String(event.sport_title ?? event.league ?? "League of Legends"),
      startTime: toIso(event.commence_time ?? event.startTime ?? event.start_time ?? Date.now()),
      status: getEventStatus(
        toIso(event.commence_time ?? event.startTime ?? event.start_time ?? Date.now()),
        event.completed,
      ),
      homeTeam: String(event.home_team ?? event.homeTeam ?? "Home").trim(),
      awayTeam: String(event.away_team ?? event.awayTeam ?? "Away").trim(),
    };

    if (!fixture.id) {
      return null;
    }

    const bookmakersRaw = Array.isArray(event.bookmakers)
      ? (event.bookmakers as Array<Record<string, unknown>>)
      : [];

    const bookmakerRows: BookmakerOdds[] = [];

    for (const book of bookmakersRaw) {
      const bookmaker = normalizeBookmaker(book.key ?? book.title ?? "unknown");
      const markets = Array.isArray(book.markets) ? (book.markets as Array<Record<string, unknown>>) : [];
      const market =
        markets.find((entry) => String(entry.key ?? "").toLowerCase() === "h2h") ?? markets[0];

      if (!market) {
        continue;
      }

      const outcomes = Array.isArray(market.outcomes)
        ? (market.outcomes as Array<Record<string, unknown>>)
        : [];

      const homeName = normalizeTeam(fixture.homeTeam);
      const awayName = normalizeTeam(fixture.awayTeam);

      const homeOutcome = outcomes.find((entry) => normalizeTeam(String(entry.name ?? "")) === homeName);
      const awayOutcome = outcomes.find((entry) => normalizeTeam(String(entry.name ?? "")) === awayName);

      const fallbackHome = outcomes[0];
      const fallbackAway = outcomes[1];

      const homeOdds = toNumber(homeOutcome?.price ?? fallbackHome?.price, NaN);
      const awayOdds = toNumber(awayOutcome?.price ?? fallbackAway?.price, NaN);
      if (!Number.isFinite(homeOdds) || !Number.isFinite(awayOdds)) {
        continue;
      }

      const clampedHome = clamp(homeOdds, 1.01, 1000);
      const clampedAway = clamp(awayOdds, 1.01, 1000);
      const homeImpliedProb = 1 / clampedHome;
      const awayImpliedProb = 1 / clampedAway;

      bookmakerRows.push({
        bookmaker,
        homeOdds: clampedHome,
        awayOdds: clampedAway,
        homeImpliedProb,
        awayImpliedProb,
        margin: homeImpliedProb + awayImpliedProb - 1,
        lastUpdated: toIso(book.last_update ?? market.last_update ?? Date.now()),
        deepLink: undefined,
      });
    }

    const filteredBooks = bookmakerRows.filter((book) => {
      return (
        this.sharpBooks.includes(book.bookmaker) ||
        this.esportsBooks.includes(book.bookmaker) ||
        book.bookmaker === "pinnacle" ||
        book.bookmaker === "betfair_exchange"
      );
    });

    const activeBooks = filteredBooks.length > 0 ? filteredBooks : bookmakerRows;
    if (activeBooks.length === 0) {
      return null;
    }

    const bestHome = activeBooks.reduce((best, current) =>
      current.homeOdds > best.homeOdds ? current : best,
    );
    const bestAway = activeBooks.reduce((best, current) =>
      current.awayOdds > best.awayOdds ? current : best,
    );

    const consensus = activeBooks.map((book) => this.removeVig(book.homeOdds, book.awayOdds));
    const consensusProb = {
      home: consensus.reduce((sum, item) => sum + item.home, 0) / consensus.length,
      away: consensus.reduce((sum, item) => sum + item.away, 0) / consensus.length,
    };

    const pinnacleOdds = activeBooks.find((book) => this.sharpBooks.includes(book.bookmaker));

    return {
      fixture,
      market: "Match Winner",
      bookmakers: activeBooks,
      bestHomeOdds: bestHome,
      bestAwayOdds: bestAway,
      pinnacleOdds,
      consensusProb,
    };
  }

  private parseTheOddsPayload(payload: unknown): FixtureOdds[] {
    if (Array.isArray(payload)) {
      return payload
        .map((entry) => this.parseTheOddsEvent(entry as Record<string, unknown>))
        .filter((entry): entry is FixtureOdds => entry !== null);
    }

    if (payload && typeof payload === "object") {
      const maybeData = (payload as Record<string, unknown>).data;
      if (Array.isArray(maybeData)) {
        return maybeData
          .map((entry) => this.parseTheOddsEvent(entry as Record<string, unknown>))
          .filter((entry): entry is FixtureOdds => entry !== null);
      }

      const one = this.parseTheOddsEvent(payload as Record<string, unknown>);
      return one ? [one] : [];
    }

    return [];
  }

  private buildMovementRowsFromBook(
    fixture: OddsFixture,
    bookmaker: string,
    homeSeries: Array<{ ts: string; price: number }>,
    awaySeries: Array<{ ts: string; price: number }>,
  ): OddsMovement[] {
    const rows: OddsMovement[] = [];
    const count = Math.min(homeSeries.length, awaySeries.length);

    for (let index = 1; index < count; index += 1) {
      const prevHome = homeSeries[index - 1];
      const currHome = homeSeries[index];
      const prevAway = awaySeries[index - 1];
      const currAway = awaySeries[index];
      const homeMove = prevHome.price - currHome.price;
      const awayMove = prevAway.price - currAway.price;
      const magnitude = Math.max(Math.abs(homeMove), Math.abs(awayMove));
      const direction: OddsMovement["direction"] =
        magnitude < 0.005
          ? "stable"
          : homeMove > awayMove
            ? "home_shortening"
            : "away_shortening";

      rows.push({
        fixture,
        bookmaker,
        timestamp: currHome.ts,
        previousHomeOdds: prevHome.price,
        currentHomeOdds: currHome.price,
        previousAwayOdds: prevAway.price,
        currentAwayOdds: currAway.price,
        direction,
        magnitude,
      });
    }

    return rows;
  }

  private extractOutcomeSeries(outcome: Record<string, unknown>, fallbackTs: string): Array<{ ts: string; price: number }> {
    if (Array.isArray(outcome.prices)) {
      return outcome.prices
        .map((entry) => ({
          ts: toIso((entry as Record<string, unknown>).timestamp ?? (entry as Record<string, unknown>).last_update ?? fallbackTs),
          price: toNumber(
            (entry as Record<string, unknown>).price ??
              (entry as Record<string, unknown>).odds ??
              (entry as Record<string, unknown>).decimal,
            NaN,
          ),
        }))
        .filter((row) => Number.isFinite(row.price))
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    }

    const singlePrice = toNumber(outcome.price ?? outcome.odds ?? outcome.decimal, NaN);
    if (Number.isFinite(singlePrice)) {
      return [{ ts: fallbackTs, price: singlePrice }];
    }

    return [];
  }

  async getUpcomingFixtures(): Promise<FixtureOdds[]> {
    if (this.provider === "theoddsapi") {
      const sportKey = await this.resolveTheOddsSportKey();
      const payload = await this.fetchFromTheOddsApi(`/sports/${encodeURIComponent(sportKey)}/odds`, {
        regions: this.theOddsRegions,
        markets: "h2h",
        oddsFormat: "decimal",
        dateFormat: "iso",
      });

      return this.parseTheOddsPayload(payload)
        .filter((row) => row.fixture.status === "pre" || row.fixture.status === "live")
        .sort((a, b) => new Date(a.fixture.startTime).getTime() - new Date(b.fixture.startTime).getTime())
        .slice(0, 30);
    }

    // Legacy fallback for old OddsPapi integration.
    const payload = await this.fetchFromOddsPapi(`/sports/${LOL_SPORT_ID}/odds`, {
      oddsFormat: "decimal",
    });

    return this.parseTheOddsPayload(payload)
      .filter((row) => row.fixture.status === "pre" || row.fixture.status === "live")
      .sort((a, b) => new Date(a.fixture.startTime).getTime() - new Date(b.fixture.startTime).getTime())
      .slice(0, 30);
  }

  async getFixtureOdds(fixtureId: string): Promise<FixtureOdds> {
    if (this.provider === "theoddsapi") {
      const sportKey = await this.resolveTheOddsSportKey();
      const payload = await this.fetchFromTheOddsApi(
        `/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(fixtureId)}/odds`,
        {
          regions: this.theOddsRegions,
          markets: "h2h",
          oddsFormat: "decimal",
          dateFormat: "iso",
        },
      );

      const parsed = this.parseTheOddsPayload(payload);
      const first = parsed[0];
      if (!first) {
        throw new Error(`No odds returned for fixture ${fixtureId}.`);
      }
      return first;
    }

    const payload = await this.fetchFromOddsPapi(`/fixtures/${fixtureId}/odds`, {
      oddsFormat: "decimal",
    });
    const parsed = this.parseTheOddsPayload(payload);
    const first = parsed[0];
    if (!first) {
      throw new Error(`No odds returned for fixture ${fixtureId}.`);
    }
    return first;
  }

  async getLiveOdds(): Promise<FixtureOdds[]> {
    const fixtures = await this.getUpcomingFixtures();
    return fixtures.filter((row) => row.fixture.status === "live");
  }

  async getHistoricalOdds(fixtureId: string): Promise<OddsMovement[]> {
    if (this.provider === "theoddsapi") {
      const sportKey = await this.resolveTheOddsSportKey();
      const payload = await this.fetchFromTheOddsApi(
        `/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(fixtureId)}/odds-history`,
        {
          regions: this.theOddsRegions,
          markets: "h2h",
          oddsFormat: "decimal",
          dateFormat: "iso",
        },
      ).catch(() => null);

      if (!payload || typeof payload !== "object") {
        return [];
      }

      const fixtureOdds = this.parseTheOddsPayload(payload)[0] ?? null;
      const event = payload as Record<string, unknown>;
      const bookmakers = Array.isArray(event.bookmakers)
        ? (event.bookmakers as Array<Record<string, unknown>>)
        : [];

      const fixture: OddsFixture =
        fixtureOdds?.fixture ??
        ({
          id: fixtureId,
          sportId: sportKey,
          league: String(event.sport_title ?? "League of Legends"),
          startTime: toIso(event.commence_time ?? Date.now()),
          status: "pre",
          homeTeam: String(event.home_team ?? "Home"),
          awayTeam: String(event.away_team ?? "Away"),
        } as OddsFixture);

      const movement: OddsMovement[] = [];
      for (const book of bookmakers) {
        const bookmaker = normalizeBookmaker(book.key ?? book.title ?? "unknown");
        const markets = Array.isArray(book.markets)
          ? (book.markets as Array<Record<string, unknown>>)
          : [];
        const market = markets.find((entry) => String(entry.key ?? "") === "h2h") ?? markets[0];
        if (!market) {
          continue;
        }

        const outcomes = Array.isArray(market.outcomes)
          ? (market.outcomes as Array<Record<string, unknown>>)
          : [];
        if (outcomes.length < 2) {
          continue;
        }

        const fallbackTs = toIso(book.last_update ?? market.last_update ?? Date.now());
        const homeSeries = this.extractOutcomeSeries(outcomes[0], fallbackTs);
        const awaySeries = this.extractOutcomeSeries(outcomes[1], fallbackTs);
        if (homeSeries.length < 2 || awaySeries.length < 2) {
          continue;
        }

        movement.push(...this.buildMovementRowsFromBook(fixture, bookmaker, homeSeries, awaySeries));
      }

      return movement.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }

    return [];
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
}

export const oddsClient = new OddsPapiClient();
