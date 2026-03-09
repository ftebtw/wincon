import "./load-env";

async function fetchJson(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text body
  }
  return { status: response.status, body };
}

function formatBody(body: unknown): string {
  if (typeof body === "string") {
    return body.slice(0, 300);
  }
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return String(body).slice(0, 300);
  }
}

async function main() {
  const key = (
    process.env.THE_ODDS_API_KEY ||
    process.env.ODDS_API_KEY ||
    ""
  ).trim();
  const sport = (process.env.THE_ODDS_API_SPORT_KEY || "esports_lol").trim();
  const regions = (process.env.THE_ODDS_API_REGIONS || "us,uk,eu,au").trim();

  if (!key) {
    throw new Error("Missing THE_ODDS_API_KEY / ODDS_API_KEY");
  }

  console.log("Checking The Odds API coverage...");
  console.log("sport:", sport, "regions:", regions);

  const sports = await fetchJson(
    `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(key)}`,
  );
  console.log("[sports] status:", sports.status);
  if (sports.status !== 200) {
    console.log("[sports] body:", formatBody(sports.body));
    return;
  }

  const upcoming = await fetchJson(
    `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(
      sport,
    )}/odds/?apiKey=${encodeURIComponent(key)}&regions=${encodeURIComponent(
      regions,
    )}&markets=h2h&oddsFormat=decimal`,
  );
  console.log("[upcoming odds] status:", upcoming.status);
  console.log("[upcoming odds] body:", formatBody(upcoming.body));

  // Historical endpoint access check (global entitlement test).
  const historical = await fetchJson(
    `https://api.the-odds-api.com/v4/historical/sports/${encodeURIComponent(
      sport,
    )}/odds?apiKey=${encodeURIComponent(
      key,
    )}&regions=${encodeURIComponent(regions)}&markets=h2h&date=2025-01-01T00:00:00Z`,
  );
  console.log("[historical odds] status:", historical.status);
  console.log("[historical odds] body:", formatBody(historical.body));

  if (historical.status === 401) {
    console.log(
      "Historical endpoint is not available for this key/plan, so ROI backtests vs market odds will skip matches.",
    );
    console.log(
      "You can still run model-only accuracy backtests with: npx tsx scripts/run-winprob-backtest.ts ...",
    );
  }
}

main().catch((error) => {
  console.error("[check-odds-coverage] Failed:", error);
  process.exit(1);
});

