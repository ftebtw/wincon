import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";

import type { WinConAPIClient } from "../lib/api-client.js";
import type { DiscordRateLimiter } from "../lib/rate-limiter.js";
import type { BotCommandName } from "../lib/rate-limiter.js";

export type BotCommandContext = {
  apiClient: WinConAPIClient;
  rateLimiter: DiscordRateLimiter;
};

export type BotSlashCommand = {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction, context: BotCommandContext) => Promise<void>;
};

export function consumeOrReplyRateLimit(params: {
  interaction: ChatInputCommandInteraction;
  context: BotCommandContext;
  command: BotCommandName;
}): Promise<boolean> {
  const result = params.context.rateLimiter.consume({
    userId: params.interaction.user.id,
    guildId: params.interaction.guildId,
    command: params.command,
  });

  if (result.allowed) {
    return Promise.resolve(true);
  }

  return params.interaction.reply({
    content:
      result.message ??
      `Rate limit reached for /${params.command}. Please try again later.`,
    ephemeral: true,
  }).then(() => false);
}
