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

  private async fetchFirstSuccess(
    candidates: Array<{ endpoint: string; params?: Record<string, string> }>,
  ): Promise<unknown> {
    let lastError: unknown = null;

    for (const candidate of candidates) {
      try {
        return await this.fetch(candidate.endpoint, candidate.params);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("No OddsPapi endpoint candidate succeeded.");
  }

  private extractRows(payload: unknown): Array<Record<string, unknown>> {
    const root = payload as
      | {
          data?: unknown[];
          fixtures?: unknown[];
          odds?: unknown[];
          tournaments?: unknown[];
          sports?: unknown[];
          results?: unknown[];
          records?: unknown[];
        }
      | unknown[]
      | null
      | undefined;

    const rows = Array.isArray(root)
      ? root
      : Array.isArray(root?.data)
        ? root.data
        : Array.isArray(root?.fixtures)
          ? root.fixtures
          : Array.isArray(root?.odds)
            ? root.odds
            : Array.isArray(root?.tournaments)
              ? root.tournaments
              : Array.isArray(root?.sports)
                ? root.sports
                : Array.isArray(root?.results)
                  ? root.results
                  : Array.isArray(root?.records)
                    ? root.records
                    : [];

    return rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }

  private looksLikeLoLSport(value: Record<string, unknown>): boolean {
    const joined = [
      value.sportName,
      value.name,
      value.slug,
      value.key,
      value.code,
      value.sportSlug,
    ]
      .map((field) => String(field ?? "").toLowerCase())
      .join(" ");

    return (
      joined.includes("league of legends") ||
      joined.includes("league-of-legends") ||
      joined.includes(" lol ")
    );
  }

  private async resolveLoLSportId(): Promise<string | null> {
    const payload = await this.fetchFirstSuccess([
      { endpoint: "/sports" },
      { endpoint: "/sport" },
    ]).catch(() => null);

    if (!payload) {
      return null;
    }

    const rows = this.extractRows(payload);
    const sport = rows.find((row) => this.looksLikeLoLSport(row));
    if (!sport) {
      return null;
    }

    const sportId = sport.sportId ?? sport.id ?? sport.sport_id ?? sport.key ?? sport.slug;
    return sportId ? String(sportId) : null;
  }

  private async resolveLoLTournamentIds(sportId: string): Promise<string[]> {
    const payload = await this.fetchFirstSuccess([
      { endpoint: "/tournaments", params: { sportId } },
      { endpoint: `/sports/${encodeURIComponent(sportId)}/tournaments` },
    ]).catch(() => null);

    if (!payload) {
      return [];
    }

    const rows = this.extractRows(payload);
    return rows
      .map((row) => row.tournamentId ?? row.id ?? row.tournament_id ?? row.key)
      .map((value) => String(value ?? "").trim())
      .filter((value) => value.length > 0);
  }

  private normalizeOddsPayload(payload: unknown): unknown {
    const rows = this.extractRows(payload);
    if (rows.length === 0) {
      if (payload && typeof payload === "object") {
        return { data: [this.normalizeOddsRow(payload as Record<string, unknown>)] };
      }
      return { data: [] };
    }

    return {
      data: rows.map((row) => this.normalizeOddsRow(row)),
    };
  }

  private normalizeOddsRow(row: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...row };
    const participant1 = String(
      row.participant1Name ??
        row.home_name ??
        (row.home as Record<string, unknown> | undefined)?.name ??
        row.homeTeam ??
        row.team1 ??
        "",
    ).trim();
    const participant2 = String(
      row.participant2Name ??
        row.away_name ??
        (row.away as Record<string, unknown> | undefined)?.name ??
        row.awayTeam ??
        row.team2 ??
        "",
    ).trim();
    if (participant1) {
      normalized.home_name = participant1;
    }
    if (participant2) {
      normalized.away_name = participant2;
    }

    const bookmakers = row.bookmakers;
    if (bookmakers && !Array.isArray(bookmakers) && typeof bookmakers === "object") {
      const bookmakerRows = Object.entries(bookmakers as Record<string, unknown>).map(
        ([bookmakerKey, bookmakerValue]) => {
          const raw = (bookmakerValue ?? {}) as Record<string, unknown>;
          const marketRowsRaw = raw.markets;
          let markets: unknown[] = [];
          if (Array.isArray(marketRowsRaw)) {
            markets = marketRowsRaw;
          } else if (marketRowsRaw && typeof marketRowsRaw === "object") {
            markets = Object.entries(marketRowsRaw as Record<string, unknown>).map(
              ([marketKey, marketValue]) => ({
                id: marketKey,
                ...(typeof marketValue === "object" && marketValue
                  ? (marketValue as Record<string, unknown>)
                  : {}),
              }),
            );
          }

          const outcomesRaw = raw.outcomes;
          const outcomes =
            Array.isArray(outcomesRaw)
              ? outcomesRaw
              : outcomesRaw && typeof outcomesRaw === "object"
                ? Object.entries(outcomesRaw as Record<string, unknown>).map(
                    ([outcomeKey, outcomeValue]) => ({
                      id: outcomeKey,
                      ...(typeof outcomeValue === "object" && outcomeValue
                        ? (outcomeValue as Record<string, unknown>)
                        : {}),
                    }),
                  )
                : [];

          return {
            key: bookmakerKey,
            name: raw.name ?? bookmakerKey,
            link: raw.deepLink ?? raw.link ?? raw.url,
            markets,
            outcomes,
          };
        },
      );

      normalized.bookmakers = bookmakerRows;
    }

    return normalized;
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
    const sportId = await this.resolveLoLSportId();
    if (!sportId) {
      return [];
    }

    const tournamentIds = await this.resolveLoLTournamentIds(sportId);
    const tournamentParam = tournamentIds.slice(0, 40).join(",");

    const payload = await this.fetchFirstSuccess([
      {
        endpoint: "/odds-by-tournaments",
        params: {
          tournamentIds: tournamentParam,
          markets: String(MARKETS.MATCH_WINNER),
          oddsFormat: "decimal",
        },
      },
      {
        endpoint: "/fixtures",
        params: {
          sportId,
          oddsFormat: "decimal",
        },
      },
      {
        endpoint: `/sports/${encodeURIComponent(sportId)}/odds`,
        params: {
          markets: String(MARKETS.MATCH_WINNER),
          oddsFormat: "decimal",
        },
      },
    ]);

    const parsed = this.parseFixtureOdds(this.normalizeOddsPayload(payload));
    return parsed
      .filter((row) => row.fixture.status === "pre" || row.fixture.status === "live")
      .sort(
        (a, b) =>
          new Date(a.fixture.startTime).getTime() -
          new Date(b.fixture.startTime).getTime(),
      )
      .slice(0, 30);
  }

  async getFixtureOdds(fixtureId: string): Promise<FixtureOdds> {
    const data = await this.fetchFirstSuccess([
      {
        endpoint: "/odds",
        params: {
          fixtureId,
          markets: Object.values(MARKETS).join(","),
          oddsFormat: "decimal",
          verbosity: "3",
        },
      },
      {
        endpoint: `/fixtures/${fixtureId}/odds`,
        params: {
          markets: Object.values(MARKETS).join(","),
          oddsFormat: "decimal",
        },
      },
    ]);

    const parsed = this.parseFixtureOdds(this.normalizeOddsPayload(data));
    const first = parsed[0];
    if (!first) {
      throw new Error(`No odds returned for fixture ${fixtureId}.`);
    }
    return first;
  }

  async getLiveOdds(): Promise<FixtureOdds[]> {
    const sportId = await this.resolveLoLSportId();
    if (!sportId) {
      return [];
    }

    const data = await this.fetchFirstSuccess([
      {
        endpoint: "/live-odds",
        params: {
          sportId,
          markets: String(MARKETS.MATCH_WINNER),
          oddsFormat: "decimal",
          verbosity: "3",
        },
      },
      {
        endpoint: `/sports/${encodeURIComponent(sportId)}/odds/live`,
        params: {
          markets: String(MARKETS.MATCH_WINNER),
          oddsFormat: "decimal",
        },
      },
    ]);

    return this.parseFixtureOdds(this.normalizeOddsPayload(data));
  }

  async getHistoricalOdds(fixtureId: string): Promise<OddsMovement[]> {
    const data = await this.fetchFirstSuccess([
      {
        endpoint: "/historical-odds",
        params: {
          fixtureId,
          oddsFormat: "decimal",
        },
      },
      {
        endpoint: `/fixtures/${fixtureId}/odds/history`,
        params: { oddsFormat: "decimal" },
      },
    ]);

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
          entry.tournamentName ??
          entry.tournament_name ??
          entry.tournament ??
          entry.competition ??
          "",
      ) || "Unknown";

    const homeTeam =
      String(
        entry.participant1Name ??
        (entry.home as Record<string, unknown> | undefined)?.name ??
        (entry.homeTeam as Record<string, unknown> | undefined)?.name ??
        entry.home_name ??
        entry.homeTeam ??
        entry.team1 ??
          "",
      ).trim() || "Home";

    const awayTeam =
      String(
        entry.participant2Name ??
        (entry.away as Record<string, unknown> | undefined)?.name ??
        (entry.awayTeam as Record<string, unknown> | undefined)?.name ??
        entry.away_name ??
        entry.awayTeam ??
        entry.team2 ??
        "",
      ).trim() || "Away";

    const statusRaw = String(entry.status ?? entry.state ?? "").toLowerCase();
    const statusId = toNumber(entry.statusId ?? entry.status_id, NaN);
    const status: OddsFixture["status"] =
      statusRaw.includes("live") ||
      statusRaw.includes("inprogress") ||
      statusRaw.includes("in_progress") ||
      statusId === 2
        ? "live"
        : statusRaw.includes("end") ||
            statusRaw.includes("final") ||
            statusRaw.includes("closed") ||
            statusId === 3
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
      : entry.bookmakers && typeof entry.bookmakers === "object"
        ? Object.entries(entry.bookmakers as Record<string, unknown>).map(
            ([key, value]) => ({
              key,
              ...(typeof value === "object" && value ? (value as Record<string, unknown>) : {}),
            }),
          )
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
      : bookmakerEntry.markets && typeof bookmakerEntry.markets === "object"
        ? Object.entries(bookmakerEntry.markets as Record<string, unknown>).map(
            ([marketId, marketValue]) => ({
              id: marketId,
              ...(typeof marketValue === "object" && marketValue
                ? (marketValue as Record<string, unknown>)
                : {}),
            }),
          )
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
        : market.outcomes && typeof market.outcomes === "object"
          ? Object.entries(market.outcomes as Record<string, unknown>).map(
              ([outcomeId, outcomeValue]) => ({
                id: outcomeId,
                ...(typeof outcomeValue === "object" && outcomeValue
                  ? (outcomeValue as Record<string, unknown>)
                  : {}),
              }),
            )
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
      : bookmakerEntry.outcomes && typeof bookmakerEntry.outcomes === "object"
        ? Object.entries(bookmakerEntry.outcomes as Record<string, unknown>).map(
            ([outcomeId, outcomeValue]) => ({
              id: outcomeId,
              ...(typeof outcomeValue === "object" && outcomeValue
                ? (outcomeValue as Record<string, unknown>)
                : {}),
            }),
          )
        : Array.isArray(bookmakerEntry.selections)
          ? (bookmakerEntry.selections as unknown[])
          : [];

    return this.mapOutcomeArray(fallbackOutcomes, fixture);
  }

  private mapOutcomeArray(outcomes: unknown[], fixture: OddsFixture): { home: number; away: number } | null {
    let homeOdds: number | null = null;
    let awayOdds: number | null = null;

    const extractPrice = (outcome: Record<string, unknown>): number => {
      const direct = toNumber(
        outcome.price ??
          outcome.odds ??
          outcome.decimal ??
          outcome.currentPrice ??
          outcome.latestPrice,
        NaN,
      );
      if (Number.isFinite(direct)) {
        return direct;
      }

      if (Array.isArray(outcome.prices)) {
        for (const row of outcome.prices) {
          const value = toNumber(
            (row as Record<string, unknown>).price ??
              (row as Record<string, unknown>).odds ??
              (row as Record<string, unknown>).decimal,
            NaN,
          );
          if (Number.isFinite(value)) {
            return value;
          }
        }
      }

      if (outcome.players && typeof outcome.players === "object") {
        const playerBuckets = Object.values(outcome.players as Record<string, unknown>);
        for (const bucket of playerBuckets) {
          if (Array.isArray(bucket)) {
            const last = bucket[bucket.length - 1] as Record<string, unknown> | undefined;
            const value = toNumber(last?.price ?? last?.odds ?? last?.decimal, NaN);
            if (Number.isFinite(value)) {
              return value;
            }
          } else if (bucket && typeof bucket === "object") {
            const value = toNumber(
              (bucket as Record<string, unknown>).price ??
                (bucket as Record<string, unknown>).odds ??
                (bucket as Record<string, unknown>).decimal,
              NaN,
            );
            if (Number.isFinite(value)) {
              return value;
            }
          }
        }
      }

      return NaN;
    };

    for (const row of outcomes) {
      const outcome = row as Record<string, unknown>;
      const name = String(
        outcome.name ??
          outcome.label ??
          outcome.participant ??
          outcome.participantName ??
          outcome.outcomeName ??
          "",
      ).toLowerCase();
      const price = extractPrice(outcome);
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
    const movement: OddsMovement[] = [];
    const rows = this.extractRows(data);

    const parseOutcomeSeries = (outcome: Record<string, unknown>): Array<{ ts: string; price: number }> => {
      if (Array.isArray(outcome.prices)) {
        return outcome.prices
          .map((row) => ({
            ts: toIso((row as Record<string, unknown>).timestamp ?? (row as Record<string, unknown>).createdAt ?? Date.now()),
            price: toNumber(
              (row as Record<string, unknown>).price ??
                (row as Record<string, unknown>).odds ??
                (row as Record<string, unknown>).decimal,
              NaN,
            ),
          }))
          .filter((row) => Number.isFinite(row.price))
          .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      }

      if (outcome.players && typeof outcome.players === "object") {
        const buckets = Object.values(outcome.players as Record<string, unknown>);
        const series: Array<{ ts: string; price: number }> = [];
        for (const bucket of buckets) {
          if (!Array.isArray(bucket)) {
            continue;
          }
          for (const row of bucket) {
            const price = toNumber(
              (row as Record<string, unknown>).price ??
                (row as Record<string, unknown>).odds ??
                (row as Record<string, unknown>).decimal,
              NaN,
            );
            if (!Number.isFinite(price)) {
              continue;
            }
            series.push({
              ts: toIso((row as Record<string, unknown>).createdAt ?? (row as Record<string, unknown>).timestamp ?? Date.now()),
              price,
            });
          }
        }
        return series.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      }

      return [];
    };

    const parseFromEntry = (entry: Record<string, unknown>) => {
      const fixture = this.parseFixture(entry) ?? {
        id: String(entry.fixtureId ?? entry.fixture_id ?? "unknown"),
        sportId: LOL_SPORT_ID,
        league: String(entry.league ?? entry.tournamentName ?? "Unknown"),
        startTime: toIso(entry.startTime ?? Date.now()),
        status: "pre",
        homeTeam: String(entry.participant1Name ?? entry.homeTeam ?? "Home"),
        awayTeam: String(entry.participant2Name ?? entry.awayTeam ?? "Away"),
      };

      const bookmakers =
        entry.bookmakers && typeof entry.bookmakers === "object" && !Array.isArray(entry.bookmakers)
          ? Object.entries(entry.bookmakers as Record<string, unknown>)
          : [];

      for (const [bookmakerKey, bookmakerValue] of bookmakers) {
        const bookmaker = normalizeBookmaker(bookmakerKey);
        const raw = (bookmakerValue ?? {}) as Record<string, unknown>;
        const marketsRaw = raw.markets;
        const marketRows = Array.isArray(marketsRaw)
          ? marketsRaw
          : marketsRaw && typeof marketsRaw === "object"
            ? Object.values(marketsRaw as Record<string, unknown>)
            : [];

        for (const marketValue of marketRows) {
          const market = (marketValue ?? {}) as Record<string, unknown>;
          const outcomesRaw = market.outcomes;
          const outcomes = Array.isArray(outcomesRaw)
            ? outcomesRaw
            : outcomesRaw && typeof outcomesRaw === "object"
              ? Object.values(outcomesRaw as Record<string, unknown>)
              : [];
          if (outcomes.length < 2) {
            continue;
          }

          const homeSeries = parseOutcomeSeries((outcomes[0] ?? {}) as Record<string, unknown>);
          const awaySeries = parseOutcomeSeries((outcomes[1] ?? {}) as Record<string, unknown>);
          const pointCount = Math.min(homeSeries.length, awaySeries.length);
          for (let index = 1; index < pointCount; index += 1) {
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

            movement.push({
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
        }
      }
    };

    if (rows.length > 0) {
      rows.forEach(parseFromEntry);
    } else if (data && typeof data === "object") {
      parseFromEntry(data as Record<string, unknown>);
    }

    return movement.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }
}

export const oddsClient = new OddsPapiClient();

