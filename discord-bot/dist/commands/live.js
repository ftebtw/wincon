import { SlashCommandBuilder } from "discord.js";
import { WinConAPIError } from "../lib/api-client.js";
import { buildLiveProEmbed } from "../lib/embed-builder.js";
import { consumeOrReplyRateLimit, } from "./types.js";
export const liveCommand = {
    data: new SlashCommandBuilder()
        .setName("live")
        .setDescription("Show currently live pro League matches"),
    async execute(interaction, context) {
        const canRun = await consumeOrReplyRateLimit({
            interaction,
            context,
            command: "live",
        });
        if (!canRun) {
            return;
        }
        await interaction.deferReply();
        try {
            const live = await context.apiClient.getProLive();
            const embed = buildLiveProEmbed({
                live,
                proUrl: context.apiClient.websiteUrl("/pro"),
            });
            await interaction.editReply({ embeds: [embed] });
        }
        catch (error) {
            if (error instanceof WinConAPIError) {
                const retrySuffix = error.retryAfter && error.status === 429
                    ? ` Retry in about ${error.retryAfter} seconds.`
                    : "";
                await interaction.editReply(`Live lookup failed (${error.status}): ${error.message}.${retrySuffix}`);
                return;
            }
            if (error instanceof Error) {
                await interaction.editReply(`Live lookup failed: ${error.message}`);
                return;
            }
            await interaction.editReply("Live lookup failed due to an unexpected error.");
        }
    },
};
