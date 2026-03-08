import {
  SlashCommandBuilder,
  type SlashCommandStringOption,
} from "discord.js";

import { WinConAPIError } from "../lib/api-client.js";
import { buildBuildEmbed } from "../lib/embed-builder.js";
import {
  type BotSlashCommand,
  consumeOrReplyRateLimit,
} from "./types.js";

function parseEnemyList(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export const buildCommand: BotSlashCommand = {
  data: new SlashCommandBuilder()
    .setName("build")
    .setDescription("Get optimal build for a champion + matchup")
    .addStringOption((option: SlashCommandStringOption) =>
      option.setName("champion").setDescription("Your champion").setRequired(true),
    )
    .addStringOption((option: SlashCommandStringOption) =>
      option
        .setName("role")
        .setDescription("Your role")
        .setRequired(true)
        .addChoices(
          { name: "Top", value: "TOP" },
          { name: "Jungle", value: "JUNGLE" },
          { name: "Mid", value: "MID" },
          { name: "ADC", value: "ADC" },
          { name: "Support", value: "SUPPORT" },
        ),
    )
    .addStringOption((option: SlashCommandStringOption) =>
      option
        .setName("enemies")
        .setDescription("Enemy team (comma-separated: Darius,Viego,Fizz,Kaisa,Nautilus)")
        .setRequired(false),
    )
    .addStringOption((option: SlashCommandStringOption) =>
      option
        .setName("allies")
        .setDescription("Ally team without you (comma-separated: Malphite,LeeSin,Ahri,Lulu)")
        .setRequired(false),
    ),

  async execute(interaction, context) {
    const canRun = await consumeOrReplyRateLimit({
      interaction,
      context,
      command: "build",
    });
    if (!canRun) {
      return;
    }

    const champion = interaction.options.getString("champion", true);
    const role = interaction.options.getString("role", true);
    const enemies = parseEnemyList(interaction.options.getString("enemies"));
    const allies = parseEnemyList(interaction.options.getString("allies"));

    await interaction.deferReply();

    try {
      const build = await context.apiClient.getBuild(
        champion,
        role,
        enemies.length > 0 ? enemies : undefined,
        allies.length > 0 ? allies : undefined,
      );

      const buildUrl = context.apiClient.websiteUrl(
        `/builds/${encodeURIComponent(champion)}`,
      );

      const embed = buildBuildEmbed({
        champion,
        role,
        enemies,
        build,
        buildUrl,
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      if (error instanceof WinConAPIError) {
        const retrySuffix =
          error.retryAfter && error.status === 429
            ? ` Retry in about ${error.retryAfter} seconds.`
            : "";
        await interaction.editReply(
          `Build lookup failed (${error.status}): ${error.message}.${retrySuffix}`,
        );
        return;
      }

      if (error instanceof Error) {
        await interaction.editReply(`Build lookup failed: ${error.message}`);
        return;
      }

      await interaction.editReply("Build lookup failed due to an unexpected error.");
    }
  },
};
