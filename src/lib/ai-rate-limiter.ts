type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: string;
  message?: string;
};

type LimitBucket = {
  count: number;
  resetAtMs: number;
};

const DEFAULT_DAILY_LIMIT = 3;
const LIMIT_HIT_MESSAGE =
  "You've used your 3 free AI analyses today. Come back tomorrow or create an account for more.";

function utcDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function nextUtcMidnightMs(now = new Date()): number {
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return midnight.getTime();
}

function parseClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? "unknown";
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

export class AIRateLimiter {
  private buckets = new Map<string, LimitBucket>();

  private currentLimit(): number {
    const parsed = Number(process.env.AI_ANALYSIS_DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_DAILY_LIMIT;
    }
    return Math.floor(parsed);
  }

  private bucketKey(params: { ip: string; userId?: string }): string {
    return `${utcDayKey()}:${params.ip}:${params.userId ?? "anon"}`;
  }

  private cleanupExpired(nowMs: number): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAtMs <= nowMs) {
        this.buckets.delete(key);
      }
    }
  }

  consume(request: Request, options?: { userId?: string }): RateLimitResult {
    const now = new Date();
    const nowMs = now.getTime();
    this.cleanupExpired(nowMs);

    const key = this.bucketKey({
      ip: parseClientIp(request),
      userId: options?.userId,
    });

    const limit = this.currentLimit();
    const existing = this.buckets.get(key) ?? {
      count: 0,
      resetAtMs: nextUtcMidnightMs(now),
    };

    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(existing.resetAtMs).toISOString(),
        message: LIMIT_HIT_MESSAGE,
      };
    }

    existing.count += 1;
    this.buckets.set(key, existing);

    return {
      allowed: true,
      remaining: Math.max(0, limit - existing.count),
      resetAt: new Date(existing.resetAtMs).toISOString(),
    };
  }
}

export const aiRateLimiter = new AIRateLimiter();
