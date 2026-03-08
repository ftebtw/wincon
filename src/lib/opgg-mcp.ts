const OPGG_MCP_URL = process.env.OPGG_MCP_URL ?? "https://mcp-api.op.gg/mcp";

interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: "tools/call";
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: {
    content?: { type: string; text?: string }[];
  };
  error?: { code: number; message: string };
}

type CounterEntry = {
  championName: string;
  winRate: number;
};

type ChampionAnalysisSummary = {
  championName: string;
  role: string;
  winRate: number;
  pickRate: number;
  banRate: number;
  tier: string;
  sampleSize: number;
  strongAgainst: CounterEntry[];
  weakAgainst: CounterEntry[];
};

type CoreItemsBlock = {
  ids: number[];
  names: string[];
  pickRate: number;
};

export interface OPGGChampionMeta {
  championName: string;
  role: string;
  winRate: number;
  pickRate: number;
  banRate: number;
  tier: string;
  builds: {
    items: {
      startItems: number[];
      coreItems: number[];
      boots: number;
      fourthItem: number[];
      fifthItem: number[];
      sixthItem: number[];
      winRates: Record<string, number>;
    };
    runes: {
      primaryTree: string;
      primaryRunes: number[];
      secondaryTree: string;
      secondaryRunes: number[];
      statShards: number[];
      winRate: number;
    };
    skillOrder: string;
    summonerSpells: number[];
  };
  counters: {
    weakAgainst: CounterEntry[];
    strongAgainst: CounterEntry[];
  };
  sampleSize: number;
}

export interface OPGGTierList {
  champions: {
    championName: string;
    role: string;
    tier: string;
    winRate: number;
    pickRate: number;
    banRate: number;
    change: "up" | "down" | "stable";
  }[];
}

export interface OPGGSummonerData {
  puuid?: string;
  gameName: string;
  tagLine: string;
  level: number;
  rank: {
    tier: string;
    division: string;
    lp: number;
  };
  wins: number;
  losses: number;
  recentGames: {
    champion: string;
    win: boolean;
    kills: number;
    deaths: number;
    assists: number;
  }[];
}

export interface OPGGChampionAnalysis {
  championName: string;
  role: string;
  winRate: number;
  pickRate: number;
  banRate: number;
  sampleSize: number;
  strongAgainst: CounterEntry[];
  weakAgainst: CounterEntry[];
  rawText: string;
}

const BOOT_IDS = new Set([3006, 3009, 3020, 3047, 3111, 3117, 3158]);

function opggEnabled(): boolean {
  return process.env.ENABLE_OPGG !== "false";
}

function toChampionKey(champion: string): string {
  return champion
    .trim()
    .toUpperCase()
    .replace(/[.'\s-]+/g, "_");
}

function normalizeRole(role: string): string {
  const normalized = role.toUpperCase();
  if (normalized === "MIDDLE") return "MID";
  if (normalized === "BOTTOM") return "ADC";
  if (normalized === "UTILITY") return "SUPPORT";
  return normalized;
}

function toOpggPosition(role: string): "all" | "top" | "jungle" | "mid" | "adc" | "support" {
  const normalized = normalizeRole(role);
  if (normalized === "TOP") return "top";
  if (normalized === "JUNGLE") return "jungle";
  if (normalized === "MID") return "mid";
  if (normalized === "ADC") return "adc";
  if (normalized === "SUPPORT") return "support";
  return "all";
}

function toOpggRegion(region: string): string {
  const normalized = region.trim().toUpperCase();
  const aliases: Record<string, string> = {
    NA: "NA",
    NA1: "NA",
    EUW: "EUW",
    EUW1: "EUW",
    EUNE: "EUNE",
    EUN1: "EUNE",
    KR: "KR",
    BR: "BR",
    BR1: "BR",
    JP: "JP",
    JP1: "JP",
    OCE: "OCE",
    OC1: "OCE",
    TR: "TR",
    TR1: "TR",
    RU: "RU",
    LAN: "LAN",
    LA1: "LAN",
    LAS: "LAS",
    LA2: "LAS",
  };
  return aliases[normalized] ?? normalized;
}

function toNumber(value: string | number | undefined, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toRate(value: string | number | undefined): number {
  const parsed = toNumber(value, 0);
  if (parsed <= 0) return 0;
  return parsed > 1 ? parsed / 100 : parsed;
}

function extractTextResult(payload: MCPResponse): string {
  return (
    payload.result?.content
      ?.filter((entry) => entry.type === "text")
      .map((entry) => entry.text ?? "")
      .join("")
      .trim() ?? ""
  );
}

function tryParseJsonText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseNumericList(value: string): number[] {
  return value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry));
}

function parseQuotedStringList(value: string): string[] {
  const results: string[] = [];
  const regex = /"([^"]+)"/g;
  for (let match = regex.exec(value); match; match = regex.exec(value)) {
    results.push(match[1]);
  }
  return results;
}

function parseCounterList(value: string): CounterEntry[] {
  const entries: CounterEntry[] = [];
  const regex = /StrongCounter\(\d+,"([^"]+)",\d+,\d+,([\d.]+)\)/g;
  for (let match = regex.exec(value); match; match = regex.exec(value)) {
    entries.push({
      championName: match[1],
      winRate: toRate(match[2]),
    });
  }
  return entries;
}

function parseChampionSummary(text: string): ChampionAnalysisSummary {
  const averageStatsMatch = text.match(
    /AverageStats\((\d+),([\d.]+),([\d.]+),([\d.]+),[\d.]+,(\d+),\d+,/,
  );

  const roleMatch = text.match(/^LolGetChampionAnalysis\("([^"]+)","([^"]+)"/);

  const countersMatch = text.match(/"[A-Z]+",(\[[\s\S]*?\]),(\[[\s\S]*?\]),Synergies/);
  const strongAgainst = countersMatch ? parseCounterList(countersMatch[1]) : [];
  const weakAgainst = countersMatch ? parseCounterList(countersMatch[2]) : [];

  return {
    championName: roleMatch?.[1] ?? "",
    role: normalizeRole(roleMatch?.[2] ?? "ALL"),
    sampleSize: toNumber(averageStatsMatch?.[1], 0),
    winRate: toRate(averageStatsMatch?.[2]),
    pickRate: toRate(averageStatsMatch?.[3]),
    banRate: toRate(averageStatsMatch?.[4]),
    tier: averageStatsMatch?.[5] ?? "3",
    strongAgainst,
    weakAgainst,
  };
}

function parseCoreItemBlocks(text: string): CoreItemsBlock[] {
  const entries: CoreItemsBlock[] = [];
  const regex = /CoreItems\(\[([0-9,\s]*)\],\[([\s\S]*?)\],\d+,\d+,([\d.]+)\)/g;

  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    const ids = parseNumericList(match[1]);
    const names = parseQuotedStringList(match[2]);
    entries.push({
      ids,
      names,
      pickRate: toRate(match[3]),
    });
  }

  return entries;
}

function buildSkillOrder(text: string): string {
  const skillMatch = text.match(/Skills\(\[([\s\S]*?)\],\d+,\d+,/);
  const raw = skillMatch?.[1] ?? "";
  const sequence = parseQuotedStringList(raw)
    .map((entry) => entry.toUpperCase())
    .filter((entry) => entry === "Q" || entry === "W" || entry === "E");
  const unique = [...new Set(sequence)];
  return unique.length > 0 ? unique.join(">") : "Q>W>E";
}

function parseRuneData(text: string): OPGGChampionMeta["builds"]["runes"] {
  const runeMatch = text.match(
    /Runes\(\d+,\d+,"([^"]+)",\[([0-9,\s]*)\],\[[\s\S]*?\],\d+,"([^"]+)",\[([0-9,\s]*)\],\[[\s\S]*?\],\[([0-9,\s]*)\],\[[\s\S]*?\],\d+,\d+,([\d.]+)\)/,
  );

  if (!runeMatch) {
    return {
      primaryTree: "",
      primaryRunes: [],
      secondaryTree: "",
      secondaryRunes: [],
      statShards: [],
      winRate: 0,
    };
  }

  return {
    primaryTree: runeMatch[1],
    primaryRunes: parseNumericList(runeMatch[2]),
    secondaryTree: runeMatch[3],
    secondaryRunes: parseNumericList(runeMatch[4]),
    statShards: parseNumericList(runeMatch[5]),
    winRate: toRate(runeMatch[6]),
  };
}

function parseMetaFromAnalysisText(
  text: string,
  champion: string,
  role: string,
): OPGGChampionMeta {
  const summary = parseChampionSummary(text);
  const resolvedRole =
    summary.role === "ALL" ? normalizeRole(role) : summary.role;
  const blocks = parseCoreItemBlocks(text);

  const coreBlock = blocks.find((entry) => entry.ids.length >= 3) ?? blocks[0];
  const bootBlock = blocks.find((entry) =>
    entry.ids.some((itemId) => BOOT_IDS.has(itemId)),
  );
  const summonerBlock = blocks.find(
    (entry) =>
      entry.ids.length === 2 && entry.ids.every((spellId) => spellId > 0 && spellId <= 30),
  );
  const starterBlock = blocks.find((entry) =>
    entry.names.some((name) => name.toLowerCase().includes("doran")),
  );

  const postCore = blocks.filter(
    (entry) =>
      entry !== coreBlock &&
      entry !== bootBlock &&
      entry !== summonerBlock &&
      entry !== starterBlock &&
      entry.ids.every((itemId) => itemId > 100),
  );

  const fourth = postCore[0]?.ids ?? [];
  const fifth = postCore[1]?.ids ?? [];
  const sixth = postCore[2]?.ids ?? [];

  return {
    championName: summary.championName || champion,
    role: resolvedRole,
    winRate: summary.winRate,
    pickRate: summary.pickRate,
    banRate: summary.banRate,
    tier: summary.tier,
    builds: {
      items: {
        startItems: starterBlock?.ids ?? [],
        coreItems: coreBlock?.ids ?? [],
        boots: bootBlock?.ids[0] ?? 0,
        fourthItem: fourth,
        fifthItem: fifth,
        sixthItem: sixth,
        winRates: {
          core: coreBlock?.pickRate ?? 0,
          fourth: postCore[0]?.pickRate ?? 0,
          fifth: postCore[1]?.pickRate ?? 0,
          sixth: postCore[2]?.pickRate ?? 0,
        },
      },
      runes: parseRuneData(text),
      skillOrder: buildSkillOrder(text),
      summonerSpells: summonerBlock?.ids ?? [],
    },
    counters: {
      weakAgainst: summary.weakAgainst,
      strongAgainst: summary.strongAgainst,
    },
    sampleSize: summary.sampleSize,
  };
}

function parseTierListText(text: string, requestedRole?: string): OPGGTierList {
  const champions: OPGGTierList["champions"] = [];
  const roleByToken: Record<string, string> = {
    Top: "TOP",
    Jungle: "JUNGLE",
    Mid: "MID",
    Adc: "ADC",
    Support: "SUPPORT",
    None: "NONE",
  };

  const regex =
    /([A-Za-z]+)\("([^"]+)",(?:true|false),(\d+),(\d+),(\d+),([\d.]+),([\d.]+),([\d.]+),([\d.]+),([\d.]+),(\d+),(\d+),(\d+),(\d+)\)/g;

  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    const roleToken = match[1];
    const role = roleByToken[roleToken] ?? normalizeRole(requestedRole ?? "ALL");
    const rank = toNumber(match[12], 999);
    const rankPrevPatch = toNumber(match[14], rank);
    const change: "up" | "down" | "stable" =
      rank < rankPrevPatch ? "up" : rank > rankPrevPatch ? "down" : "stable";

    champions.push({
      championName: match[2],
      role,
      tier: match[11],
      winRate: toRate(match[6]),
      pickRate: toRate(match[7]),
      banRate: toRate(match[9]),
      change,
    });
  }

  return { champions };
}

function parseSummonerText(
  text: string,
  gameName: string,
  tagLine: string,
): OPGGSummonerData {
  const idMatch = text.match(/Summoner\([^,]*,[^,]*,[^,]*,"([^"]+)"/);
  const basicMatch = text.match(
    /Summoner\([^,]*,[^,]*,[^,]*,[^,]*,"([^"]+)","([^"]+)","[^"]*","[^"]*","[^"]*",(\d+),/,
  );
  const soloMatch = text.match(
    /LeagueStat\("SOLORANKED",TierInfo\("([A-Z]+|null)",([^,]+),([^,]+),[\s\S]*?\),([^,]+),([^,]+),/,
  );
  const flexMatch = text.match(
    /LeagueStat\("FLEXRANKED",TierInfo\("([A-Z]+|null)",([^,]+),([^,]+),[\s\S]*?\),([^,]+),([^,]+),/,
  );
  const rankMatch = soloMatch ?? flexMatch;

  const tier = rankMatch?.[1] && rankMatch[1] !== "null" ? rankMatch[1] : "UNRANKED";
  const divisionRaw = rankMatch?.[2] ?? "";
  const division = Number.isFinite(Number(divisionRaw))
    ? String(divisionRaw)
    : "";
  const lp = toNumber(rankMatch?.[3], 0);
  const wins = toNumber(rankMatch?.[4], 0);
  const losses = toNumber(rankMatch?.[5], 0);

  return {
    puuid: idMatch?.[1],
    gameName: basicMatch?.[1] ?? gameName,
    tagLine: basicMatch?.[2] ?? tagLine,
    level: toNumber(basicMatch?.[3], 0),
    rank: {
      tier,
      division,
      lp,
    },
    wins,
    losses,
    recentGames: [],
  };
}

function parseChampionPositionsText(text: string): Array<{
  position: string;
  winRate: number;
  pickRate: number;
}> {
  const results: Array<{ position: string; winRate: number; pickRate: number }> = [];
  const regex = /Position\("([A-Z]+)",Stats\(\d+,([\d.]+),([\d.]+),/g;
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    results.push({
      position: normalizeRole(match[1]),
      winRate: toRate(match[2]),
      pickRate: toRate(match[3]),
    });
  }
  return results;
}

export class OPGGMCPClient {
  private cache = new Map<string, { data: unknown; expiresAt: number }>();

  private getTTL(toolName: string): number {
    if (toolName.includes("champion")) return 60 * 60 * 1000;
    if (toolName.includes("summoner")) return 5 * 60 * 1000;
    if (toolName.includes("esports")) return 15 * 60 * 1000;
    return 30 * 60 * 1000;
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!opggEnabled()) {
      throw new Error("OP.GG integration is disabled.");
    }

    const cacheKey = `${toolName}:${JSON.stringify(args)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const response = await fetch(OPGG_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`OP.GG MCP error: ${response.status}`);
    }

    const payload = (await response.json()) as MCPResponse;
    if (payload.error) {
      throw new Error(`OP.GG MCP tool error: ${payload.error.message}`);
    }

    const text = extractTextResult(payload);
    const data = tryParseJsonText(text);
    this.cache.set(cacheKey, {
      data,
      expiresAt: Date.now() + this.getTTL(toolName),
    });
    return data;
  }

  async getChampionMeta(champion: string, role: string): Promise<OPGGChampionMeta> {
    const analysisText = await this.callTool("lol_get_champion_analysis", {
      game_mode: "ranked",
      champion: toChampionKey(champion),
      position: toOpggPosition(role),
      lang: "en_US",
    });

    const text = typeof analysisText === "string" ? analysisText : JSON.stringify(analysisText);
    return parseMetaFromAnalysisText(text, champion, role);
  }

  async getChampionAnalysis(champion: string, role = "all"): Promise<OPGGChampionAnalysis> {
    const analysisText = await this.callTool("lol_get_champion_analysis", {
      game_mode: "ranked",
      champion: toChampionKey(champion),
      position: toOpggPosition(role),
      lang: "en_US",
    });

    const text = typeof analysisText === "string" ? analysisText : JSON.stringify(analysisText);
    const summary = parseChampionSummary(text);
    const resolvedRole =
      summary.role === "ALL" ? normalizeRole(role) : summary.role;

    return {
      championName: summary.championName || champion,
      role: resolvedRole,
      winRate: summary.winRate,
      pickRate: summary.pickRate,
      banRate: summary.banRate,
      sampleSize: summary.sampleSize,
      strongAgainst: summary.strongAgainst,
      weakAgainst: summary.weakAgainst,
      rawText: text,
    };
  }

  async getTierList(role?: string): Promise<OPGGTierList> {
    const data = await this.callTool("lol_list_lane_meta_champions", {
      position: role ? toOpggPosition(role) : "all",
      lang: "en_US",
    });

    const text = typeof data === "string" ? data : JSON.stringify(data);
    return parseTierListText(text, role);
  }

  async getChampionPositions(champion: string): Promise<{
    championName: string;
    positions: Array<{ position: string; winRate: number; pickRate: number }>;
  }> {
    const data = await this.callTool("lol_get_champion_analysis", {
      game_mode: "ranked",
      champion: toChampionKey(champion),
      position: "all",
      lang: "en_US",
    });
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return {
      championName: champion,
      positions: parseChampionPositionsText(text),
    };
  }

  async getSummoner(
    gameName: string,
    tagLine: string,
    region = "NA",
  ): Promise<OPGGSummonerData> {
    const data = await this.callTool("lol_get_summoner_profile", {
      game_name: gameName,
      tag_line: tagLine,
      region: toOpggRegion(region),
      lang: "en_US",
    });

    const text = typeof data === "string" ? data : JSON.stringify(data);
    return parseSummonerText(text, gameName, tagLine);
  }

  async getSummonerGames(
    gameName: string,
    tagLine: string,
    region = "NA",
  ): Promise<unknown> {
    return this.callTool("lol_list_summoner_matches", {
      game_name: gameName,
      tag_line: tagLine,
      region: toOpggRegion(region),
      lang: "en_US",
      limit: 20,
    });
  }

  async getEsportsSchedule(): Promise<unknown> {
    return this.callTool("lol_esports_list_schedules", {});
  }

  async getEsportsStandings(league: string): Promise<unknown> {
    return this.callTool("lol_esports_list_team_standings", {
      short_name: league.toLowerCase(),
    });
  }
}

export const opggClient = new OPGGMCPClient();
