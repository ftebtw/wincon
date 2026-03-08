import { SlashCommandBuilder, } from "discord.js";
import { WinConAPIError, toRiotSlug } from "../lib/api-client.js";
import { buildScoutEmbed } from "../lib/embed-builder.js";
import { consumeOrReplyRateLimit, } from "./types.js";
export const scoutCommand = {
    data: new SlashCommandBuilder()
        .setName("scout")
        .setDescription("Scout your current game (loading screen)")
        .addStringOption((option) => option.setName("riotid").setDescription("Riot ID").setRequired(true)),
    async execute(interaction, context) {
        const canRun = await consumeOrReplyRateLimit({
            interaction,
            context,
            command: "scout",
        });
        if (!canRun) {
            return;
        }
        const riotId = interaction.options.getString("riotid", true);
        await interaction.deferReply();
        try {
            const liveGame = await context.apiClient.getLiveGame(riotId);
            if (!liveGame.inGame) {
                await interaction.editReply(`${riotId} is not currently in a game. Try again when you're in loading screen.`);
                return;
            }
            const riotSlug = toRiotSlug(riotId);
            const scoutUrl = context.apiClient.websiteUrl(`/livegame/${riotSlug}`);
            const embed = buildScoutEmbed({
                riotId,
                liveGame,
                scoutUrl,
            });
            await interaction.editReply({ embeds: [embed] });
        }
        catch (error) {
            if (error instanceof WinConAPIError) {
                const retrySuffix = error.retryAfter && error.status === 429
                    ? ` Retry in about ${error.retryAfter} seconds.`
                    : "";
                await interaction.editReply(`Scout failed (${error.status}): ${error.message}.${retrySuffix}`);
                return;
            }
            if (error instanceof Error) {
                await interaction.editReply(`Scout failed: ${error.message}`);
                return;
            }
            await interaction.editReply("Scout failed due to an unexpected error.");
        }
    },
};
