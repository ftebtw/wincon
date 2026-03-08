# WinCon.gg Discord Bot

Standalone Discord bot process for WinCon.gg slash commands.

## Commands
- `/analyze riotid:Player#NA1`
- `/scout riotid:Player#NA1`
- `/profile riotid:Player#NA1`
- `/progress riotid:Player#NA1`
- `/build champion:Jinx role:ADC enemies:Darius,Viego,Fizz,Kaisa,Nautilus`

## Local Setup
1. `cd discord-bot`
2. `npm install`
3. Copy `.env.example` to `.env` and fill required values.
4. `npm run dev`

## Required Bot Permissions
- `Send Messages`
- `Embed Links`
- `Use Slash Commands`

## OAuth2 Scopes
- `bot`
- `applications.commands`

## Deployment
Run as a long-lived Node process (not serverless):
- Railway.app (recommended)
- Fly.io
- VPS with PM2

Production command:
- `npm run build && npm run start`
