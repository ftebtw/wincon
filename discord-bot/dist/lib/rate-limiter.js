const HOUR_MS = 60 * 60 * 1000;
const USER_LIMITS = {
    analyze: 3,
    scout: 5,
    profile: 10,
    progress: 10,
    build: 10,
    live: 10,
};
const SERVER_LIMIT_PER_HOUR = 50;
function pruneTimestamps(timestamps, now) {
    return timestamps.filter((timestamp) => now - timestamp < HOUR_MS);
}
function retryAfterMinutes(oldestTimestamp, now) {
    const retryAfterMs = Math.max(0, HOUR_MS - (now - oldestTimestamp));
    return Math.max(1, Math.ceil(retryAfterMs / 60_000));
}
export class DiscordRateLimiter {
    userCommandBuckets = new Map();
    serverBuckets = new Map();
    consume(input) {
        const now = Date.now();
        const userKey = `${input.userId}:${input.command}`;
        const userLimit = USER_LIMITS[input.command];
        const userBucket = pruneTimestamps(this.userCommandBuckets.get(userKey) ?? [], now);
        if (userBucket.length >= userLimit) {
            const minutes = retryAfterMinutes(userBucket[0] ?? now, now);
            return {
                allowed: false,
                retryAfterMinutes: minutes,
                message: `You've reached your limit for /${input.command} (${userLimit}/hour). Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
            };
        }
        if (input.guildId) {
            const serverBucket = pruneTimestamps(this.serverBuckets.get(input.guildId) ?? [], now);
            if (serverBucket.length >= SERVER_LIMIT_PER_HOUR) {
                const minutes = retryAfterMinutes(serverBucket[0] ?? now, now);
                return {
                    allowed: false,
                    retryAfterMinutes: minutes,
                    message: `This server has reached its command limit (${SERVER_LIMIT_PER_HOUR}/hour). Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
                };
            }
            serverBucket.push(now);
            this.serverBuckets.set(input.guildId, serverBucket);
        }
        userBucket.push(now);
        this.userCommandBuckets.set(userKey, userBucket);
        return { allowed: true };
    }
}
export const discordRateLimiter = new DiscordRateLimiter();
