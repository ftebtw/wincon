# WinCon.gg

AI-powered League of Legends coaching platform built on Next.js.

This repo includes:
- Player search and match analysis
- Win probability + key moments + deep play-by-play
- WPA (Win Probability Added) per-player attribution
- Matchup guides + Meraki ability data
- CDragon + PBE diff preview
- Pro section (historical + live)
- OP.GG MCP integration
- Contextual build engine
- Similar game search ("What Would a Pro Do?")
- Private betting research tools (password-protected)

## Tech Stack

- Next.js 16 + React 19 + TypeScript
- PostgreSQL + Drizzle ORM
- Anthropic API (Opus/Sonnet)
- Riot API
- OP.GG MCP
- The Odds API + Polymarket integrations (private module)

## Quick Start

1. Install dependencies:
```bash
npm install
```

2. Copy env template:
```bash
cp .env.example .env.local
```

3. Fill required vars in `.env.local`:
- `RIOT_API_KEY`
- `DATABASE_URL`
- `ANTHROPIC_API_KEY`
- `CRON_SECRET`
- `NEXT_PUBLIC_DATA_DRAGON_VERSION`

4. Push schema:
```bash
npm run db:push
```

5. Run the app:
```bash
npm run dev
```

6. Open:
- `http://localhost:3000`

## Environment Variables

Core:
- `RIOT_API_KEY`: Riot API key
- `DATABASE_URL`: Postgres connection string
- `ANTHROPIC_API_KEY`: Claude API key
- `CRON_SECRET`: shared secret for cron endpoints (`Authorization: Bearer <secret>`)
- `NEXT_PUBLIC_DATA_DRAGON_VERSION`: Data Dragon patch version

Feature flags and integrations:
- `ENABLE_OPGG`
- `OPGG_MCP_URL`
- `ENABLE_ESPORTS_LIVE`
- `THE_ODDS_API_KEY` (primary odds feed)
- `THE_ODDS_API_SPORT_KEY` (optional override, default `esports_lol`)
- `THE_ODDS_API_REGIONS` (optional, default `us,uk,eu,au`)
- `BETTING_ADMIN_PASSWORD`
- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_PASSPHRASE`
- `BETTING_ENABLED`
- `BETTING_DRY_RUN`

Use `.env.example` as the source of truth for the full list.

## Scripts

- `npm run dev`: start local app
- `npm run build`: production build
- `npm run start`: run production server
- `npm run lint`: lint project
- `npm run db:push`: apply Drizzle schema to DB
- `npm run db:generate`: generate migrations
- `npm run db:studio`: open Drizzle Studio
- `npm run backtest`: run betting backtest script

Other scripts in `scripts/`:
- `seed-matchup-guides.ts`
- `seed-builds.ts`
- `seed-vectors.ts`
- `initial-collection.ts`
- `generate-threat-map.ts`
- `scrape-pro-accounts.ts`
- `run-backtest.ts`

## Key Routes

Pages:
- `/` Home
- `/player/[riotId]` Player overview
- `/match/[matchId]` Match analysis
- `/livegame/[riotId]` Loading-screen scout
- `/matchup/[matchupId]` Matchup guide
- `/champions` Champion tier/meta pages
- `/pro` Pro section
- `/pbe` PBE preview
- `/private/betting` Private betting dashboard

API:
- `/api/player/[riotId]`
- `/api/match/[matchId]`
- `/api/livegame/[riotId]`
- `/api/matchup/[matchupId]`
- `/api/build`
- `/api/similar`
- `/api/pro/*`
- `/api/pbe`
- `/api/cron/*`
- `/api/private/*`

## Cron Jobs

Configured in `vercel.json`:
- `/api/cron/collect`
- `/api/cron/compute-stats`
- `/api/cron/import-pro-data`
- `/api/cron/patch-check`
- `/api/cron/pbe-check`
- `/api/cron/compute-progress`

All cron routes require `Authorization: Bearer <CRON_SECRET>`.

## Private Betting Module

- Private routes are protected in middleware.
- Access is disabled unless `BETTING_ADMIN_PASSWORD` is set.
- Keep this section unlinked from public nav/sitemap if deploying publicly.

## Notes

- Do not commit real API keys or secrets.
- This codebase expects a live Postgres DB for most non-trivial flows.
