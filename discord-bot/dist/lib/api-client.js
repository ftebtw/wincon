import fetch from "node-fetch";
export class WinConAPIError extends Error {
    status;
    retryAfter;
    constructor(status, message, retryAfter) {
        super(message);
        this.name = "WinConAPIError";
        this.status = status;
        this.retryAfter = retryAfter;
    }
}
function parseRiotId(riotId, regionFallback) {
    const trimmed = riotId.trim();
    const separatorIndex = trimmed.lastIndexOf("#");
    if (separatorIndex === -1) {
        if (!regionFallback) {
            throw new Error("Riot ID must include # tag (example: Player#NA1).");
        }
        return {
            gameName: trimmed,
            tagLine: regionFallback.toUpperCase(),
        };
    }
    const gameName = trimmed.slice(0, separatorIndex).trim();
    const tagLine = trimmed.slice(separatorIndex + 1).trim();
    if (!gameName || !tagLine) {
        throw new Error("Invalid Riot ID format. Use Player#TAG.");
    }
    return { gameName, tagLine };
}
export function toRiotSlug(riotId, regionFallback) {
    const parsed = parseRiotId(riotId, regionFallback);
    return `${encodeURIComponent(parsed.gameName)}-${encodeURIComponent(parsed.tagLine)}`;
}
function defaultEnemyTeam() {
    return ["Aatrox", "Viego", "Ahri", "KaiSa", "Nautilus"];
}
function defaultAllies(champion, role) {
    const baseline = ["Ornn", "LeeSin", "Orianna", "Jinx", "Lulu"];
    const normalizedRole = role.toUpperCase();
    const roleToIndex = {
        TOP: 0,
        JUNGLE: 1,
        MID: 2,
        ADC: 3,
        SUPPORT: 4,
    };
    const index = roleToIndex[normalizedRole] ?? 2;
    baseline[index] = champion;
    return baseline;
}
export class WinConAPIClient {
    baseUrl;
    secret;
    constructor(params) {
        this.baseUrl = (params?.baseUrl ?? process.env.WINCON_API_BASE_URL ?? "https://wincon.gg").replace(/\/$/, "");
        this.secret = params?.secret ?? process.env.WINCON_API_SECRET;
    }
    async request(path, timeoutMs = 45_000) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const headers = {
            Accept: "application/json",
        };
        if (this.secret) {
            headers["x-wincon-secret"] = this.secret;
        }
        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method: "GET",
                headers,
                signal: controller.signal,
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => ({})));
                throw new WinConAPIError(response.status, payload.error ?? `WinCon API request failed (${response.status}).`, payload.retryAfter);
            }
            return (await response.json());
        }
        catch (error) {
            if (error instanceof WinConAPIError) {
                throw error;
            }
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error("Request to WinCon API timed out.");
            }
            throw error;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    websiteUrl(path) {
        return `${this.baseUrl}${path}`;
    }
    async getPlayer(riotId, region) {
        const slug = toRiotSlug(riotId, region);
        return this.request(`/api/player/${slug}`);
    }
    async getMatch(matchId, puuid) {
        return this.request(`/api/match/${encodeURIComponent(matchId)}?player=${encodeURIComponent(puuid)}`, 30_000);
    }
    async getMatchAnalysis(matchId, puuid) {
        return this.request(`/api/analysis/${encodeURIComponent(matchId)}?player=${encodeURIComponent(puuid)}`, 70_000);
    }
    async getLiveGame(riotId) {
        const slug = toRiotSlug(riotId);
        return this.request(`/api/livegame/${slug}`, 45_000);
    }
    async getProgress(puuid, period = "week") {
        return this.request(`/api/progress/${encodeURIComponent(puuid)}?period=${period}`, 30_000);
    }
    async getBuild(champion, role, enemies, allies) {
        const allyList = (allies && allies.length > 0 ? allies : defaultAllies(champion, role))
            .map((entry) => entry.trim())
            .filter(Boolean)
            .join(",");
        const enemyList = (enemies && enemies.length > 0 ? enemies : defaultEnemyTeam())
            .map((entry) => entry.trim())
            .filter(Boolean)
            .join(",");
        const path = `/api/builds/${encodeURIComponent(champion)}` +
            `?role=${encodeURIComponent(role.toUpperCase())}` +
            `&allies=${encodeURIComponent(allyList)}` +
            `&enemies=${encodeURIComponent(enemyList)}`;
        return this.request(path, 30_000);
    }
    async getProLive() {
        return this.request("/api/pro/live", 20_000);
    }
}
