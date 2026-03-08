import { Client, GatewayIntentBits, REST, Routes, } from "discord.js";
import { analyzeCommand } from "./commands/analyze.js";
import { buildCommand } from "./commands/build.js";
import { liveCommand } from "./commands/live.js";
import { profileCommand } from "./commands/profile.js";
import { progressCommand } from "./commands/progress.js";
import { scoutCommand } from "./commands/scout.js";
import { WinConAPIClient } from "./lib/api-client.js";
import { discordRateLimiter } from "./lib/rate-limiter.js";
function requireEnv(name) {
    const value = process.env[name];
    if (!value || value.trim().length === 0) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
const botToken = requireEnv("DISCORD_BOT_TOKEN");
const clientId = requireEnv("DISCORD_CLIENT_ID");
const apiClient = new WinConAPIClient({
    baseUrl: process.env.WINCON_API_BASE_URL,
    secret: process.env.WINCON_API_SECRET,
});
const commands = [
    analyzeCommand,
    scoutCommand,
    profileCommand,
    progressCommand,
    buildCommand,
    liveCommand,
];
const commandMap = new Map(commands.map((command) => [command.data.name, command]));
async function registerSlashCommands() {
    const rest = new REST({ version: "10" }).setToken(botToken);
    const payload = commands.map((command) => command.data.toJSON());
    await rest.put(Routes.applicationCommands(clientId), {
        body: payload,
    });
    console.log(`[DiscordBot] Registered ${payload.length} slash commands.`);
}
async function main() {
    await registerSlashCommands();
    const client = new Client({
        intents: [GatewayIntentBits.Guilds],
    });
    client.once("ready", () => {
        const tag = client.user?.tag ?? "unknown";
        console.log(`[DiscordBot] Logged in as ${tag}`);
    });
    client.on("interactionCreate", async (interaction) => {
        if (!interaction.isChatInputCommand()) {
            return;
        }
        const command = commandMap.get(interaction.commandName);
        if (!command) {
            await interaction.reply({
                content: `Unknown command: /${interaction.commandName}`,
                ephemeral: true,
            });
            return;
        }
        try {
            await command.execute(interaction, {
                apiClient,
                rateLimiter: discordRateLimiter,
            });
        }
        catch (error) {
            console.error(`[DiscordBot] Command /${interaction.commandName} failed:`, error);
            const message = "Command failed unexpectedly. Please try again.";
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(message).catch(() => undefined);
            }
            else {
                await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
            }
        }
    });
    await client.login(botToken);
}
main().catch((error) => {
    console.error("[DiscordBot] Fatal startup error:", error);
    process.exitCode = 1;
});
