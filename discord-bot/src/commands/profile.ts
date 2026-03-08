import {
  SlashCommandBuilder,
  type SlashCommandStringOption,
} from "discord.js";

import { WinConAPIError, toRiotSlug } from "../lib/api-client.js";
import { buildProfileEmbed } from "../lib/embed-builder.js";
import {
  type BotSlashCommand,
  consumeOrReplyRateLimit,
} from "./types.js";

function derivePatternLineFromRecentMatches(matches: Array<{
  win: boolean;
  deaths: number;
  cs: number;
  gameDuration: number;
}>): string {
  if (matches.length === 0) {
    return "Not enough recent data to detect a pattern.";
  }

  const losses = matches.filter((match) => !match.win);
  const highDeathLosses = losses.filter((match) => match.deaths >= 7);
  if (losses.length >= 3 && highDeathLosses.length / losses.length >= 0.5) {
    return `High death count in losses (${highDeathLosses.length}/${losses.length} losses with 7+ deaths).`;
  }

  const lowCsGames = matches.filter((match) => {
    const minutes = Math.max(1, match.gameDuration / 60);
    return match.cs / minutes < 6.5;
  });
  if (lowCsGames.length / matches.length >= 0.6) {
    return `Low farm trend (${lowCsGames.length}/${matches.length} games below 6.5 CS/min).`;
  }

  const lateGameLosses = losses.filter((match) => match.gameDuration >= 1800);
  if (lateGameLosses.length >= 3) {
    return `${lateGameLosses.length} recent long games ended in losses; focus on late objective setups.`;
  }

  return "No severe recurring issue detected in recent games.";
}

export const profileCommand: BotSlashCommand = {
  data: new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View player profile and rank")
    .addStringOption((option: SlashCommandStringOption) =>
      option.setName("riotid").setDescription("Riot ID").setRequired(true),
    ),

  async execute(interaction, context) {
    const canRun = await consumeOrReplyRateLimit({
      interaction,
      context,
      command: "profile",
    });
    if (!canRun) {
      return;
    }

    const riotId = interaction.options.getString("riotid", true);
    await interaction.deferReply();

    try {
      const player = await context.apiClient.getPlayer(riotId);
      const profileUrl = context.apiClient.websiteUrl(`/player/${toRiotSlug(riotId)}`);
      const patternLine = derivePatternLineFromRecentMatches(player.recentMatches);

      const embed = buildProfileEmbed({
        riotId,
        player,
        profileUrl,
        patternLine,
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      if (error instanceof WinConAPIError) {
        const retrySuffix =
          error.retryAfter && error.status === 429
            ? ` Retry in about ${error.retryAfter} seconds.`
            : "";
        await interaction.editReply(
          `Profile lookup failed (${error.status}): ${error.message}.${retrySuffix}`,
        );
        return;
      }

      if (error instanceof Error) {
        await interaction.editReply(`Profile lookup failed: ${error.message}`);
        return;
      }

      await interaction.editReply("Profile lookup failed due to an unexpected error.");
    }
  },
};
