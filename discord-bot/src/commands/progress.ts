import {
  SlashCommandBuilder,
  type SlashCommandStringOption,
} from "discord.js";

import { WinConAPIError, toRiotSlug } from "../lib/api-client.js";
import { buildProgressEmbed } from "../lib/embed-builder.js";
import {
  type BotSlashCommand,
  consumeOrReplyRateLimit,
} from "./types.js";

export const progressCommand: BotSlashCommand = {
  data: new SlashCommandBuilder()
    .setName("progress")
    .setDescription("See your improvement this week")
    .addStringOption((option: SlashCommandStringOption) =>
      option.setName("riotid").setDescription("Riot ID").setRequired(true),
    ),

  async execute(interaction, context) {
    const canRun = await consumeOrReplyRateLimit({
      interaction,
      context,
      command: "progress",
    });
    if (!canRun) {
      return;
    }

    const riotId = interaction.options.getString("riotid", true);
    await interaction.deferReply();

    try {
      const player = await context.apiClient.getPlayer(riotId);
      const progress = await context.apiClient.getProgress(player.player.puuid, "week");

      const progressUrl = context.apiClient.websiteUrl(
        `/player/${toRiotSlug(riotId)}/progress`,
      );

      const embed = buildProgressEmbed({
        riotId,
        progress,
        progressUrl,
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      if (error instanceof WinConAPIError) {
        const retrySuffix =
          error.retryAfter && error.status === 429
            ? ` Retry in about ${error.retryAfter} seconds.`
            : "";
        await interaction.editReply(
          `Progress lookup failed (${error.status}): ${error.message}.${retrySuffix}`,
        );
        return;
      }

      if (error instanceof Error) {
        await interaction.editReply(`Progress lookup failed: ${error.message}`);
        return;
      }

      await interaction.editReply("Progress lookup failed due to an unexpected error.");
    }
  },
};
