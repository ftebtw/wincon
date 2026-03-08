export function consumeOrReplyRateLimit(params) {
    const result = params.context.rateLimiter.consume({
        userId: params.interaction.user.id,
        guildId: params.interaction.guildId,
        command: params.command,
    });
    if (result.allowed) {
        return Promise.resolve(true);
    }
    return params.interaction.reply({
        content: result.message ??
            `Rate limit reached for /${params.command}. Please try again later.`,
        ephemeral: true,
    }).then(() => false);
}
