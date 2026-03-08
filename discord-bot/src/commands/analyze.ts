import {
  SlashCommandBuilder,
  type SlashCommandStringOption,
} from "discord.js";

import { buildAnalyzeEmbed } from "../lib/embed-builder.js";
import { WinConAPIError } from "../lib/api-client.js";
import {
  type BotSlashCommand,
  consumeOrReplyRateLimit,
} from "./types.js";

export const analyzeCommand: BotSlashCommand = {
  data: new SlashCommandBuilder()
    .setName("analyze")
    .setDescription("Get AI coaching for your last game")
    .addStringOption((option: SlashCommandStringOption) =>
      option
        .setName("riotid")
        .setDescription("Riot ID (e.g., Player#NA1)")
        .setRequired(true),
    )
    .addStringOption((option: SlashCommandStringOption) =>
      option
        .setName("region")
        .setDescription("Region fallback if Riot ID does not include #tag")
        .setRequired(false)
        .addChoices(
          { name: "NA", value: "NA" },
          { name: "EUW", value: "EUW" },
          { name: "EUNE", value: "EUNE" },
          { name: "KR", value: "KR" },
          { name: "JP", value: "JP" },
        ),
    ),

  async execute(interaction, context) {
    const canRun = await consumeOrReplyRateLimit({
      interaction,
      context,
      command: "analyze",
    });
    if (!canRun) {
      return;
    }

    const riotId = interaction.options.getString("riotid", true);
    const region = interaction.options.getString("region") ?? undefined;

    await interaction.deferReply();

    try {
      const player = await context.apiClient.getPlayer(riotId, region);

      if (player.recentMatches.length === 0) {
        await interaction.editReply(
          `No recent ranked matches found for ${player.player.gameName}#${player.player.tagLine}.`,
        );
        return;
      }

      const latestMatch = player.recentMatches[0];
      const [match, analysis] = await Promise.all([
        context.apiClient.getMatch(latestMatch.matchId, player.player.puuid),
        context.apiClient.getMatchAnalysis(latestMatch.matchId, player.player.puuid),
      ]);
      let proReferenceLine: string | undefined;
      try {
        const negativeMoment = [...match.keyMoments]
          .filter((moment) => moment.type === "negative")
          .sort((a, b) => a.totalDelta - b.totalDelta)[0];
        const defaultMinute = negativeMoment?.minute ?? 15;
        const similar = await context.apiClient.getSimilar(
          latestMatch.matchId,
          player.player.puuid,
          defaultMinute,
        );
        const top = similar.results[0];
        if (top) {
          const source = top.gameState.metadata.isProGame
            ? [top.gameState.metadata.playerName, top.gameState.metadata.teamName]
                .filter(Boolean)
                .join(" - ") || "Pro play"
            : [top.gameState.metadata.rank, top.gameState.metadata.region]
                .filter(Boolean)
                .join(" - ") || "high elo";
          proReferenceLine =
            `In a similar spot, ${source} ${top.gameState.metadata.playerChampion} ` +
            `at ${top.gameState.metadata.minute}m: ${top.gameState.outcome.next5MinEvents}`;
        }
      } catch (error) {
        console.warn("[Discord:/analyze] Similarity lookup failed:", error);
      }

      const matchUrl = context.apiClient.websiteUrl(
        `/match/${encodeURIComponent(latestMatch.matchId)}?player=${encodeURIComponent(player.player.puuid)}`,
      );

      const embed = buildAnalyzeEmbed({
        player,
        match,
        analysis,
        matchUrl,
        proReference: proReferenceLine,
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      if (error instanceof WinConAPIError) {
        const retrySuffix =
          error.retryAfter && error.status === 429
            ? ` Retry in about ${error.retryAfter} seconds.`
            : "";
        await interaction.editReply(
          `Analyze failed (${error.status}): ${error.message}.${retrySuffix}`,
        );
        return;
      }

      if (error instanceof Error) {
        await interaction.editReply(`Analyze failed: ${error.message}`);
        return;
      }

      await interaction.editReply("Analyze failed due to an unexpected error.");
    }
  },
};
