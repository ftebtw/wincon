import { RiotAPIError } from "@/lib/riot-api";

type BucketType = "short" | "long";
export type RateLimitPriority = "high" | "low";

type BucketConfig = {
  capacity: number;
  windowMs: number;
};

type BucketState = BucketConfig & {
  tokens: number;
  lastRefillMs: number;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class RiotRateLimiter {
  private readonly shortBucket: BucketState = {
    capacity: 20,
    windowMs: 1_000,
    tokens: 20,
    lastRefillMs: Date.now(),
  };

  private readonly longBucket: BucketState = {
    capacity: 100,
    windowMs: 120_000,
    tokens: 100,
    lastRefillMs: Date.now(),
  };

  private queue: Promise<void> = Promise.resolve();
  private highPriorityInFlight = 0;

  private async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.queue;
    let release!: () => void;

    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await fn();
    } finally {
      release();
    }
  }

  private refillBucket(bucket: BucketState) {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefillMs;

    if (elapsedMs <= 0) {
      return;
    }

    const refillPerMs = bucket.capacity / bucket.windowMs;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedMs * refillPerMs);
    bucket.lastRefillMs = now;
  }

  private getWaitMs(bucket: BucketState): number {
    if (bucket.tokens >= 1) {
      return 0;
    }

    const refillPerMs = bucket.capacity / bucket.windowMs;
    return Math.ceil((1 - bucket.tokens) / refillPerMs);
  }

  private consumeOneToken(bucket: BucketState) {
    bucket.tokens = Math.max(0, bucket.tokens - 1);
  }

  private async acquireTokens(): Promise<void> {
    while (true) {
      const waitState = await this.withLock<{
        waitMs: number;
        bucket: BucketType | "short+long";
      } | null>(() => {
        this.refillBucket(this.shortBucket);
        this.refillBucket(this.longBucket);

        const shortWait = this.getWaitMs(this.shortBucket);
        const longWait = this.getWaitMs(this.longBucket);

        if (shortWait === 0 && longWait === 0) {
          this.consumeOneToken(this.shortBucket);
          this.consumeOneToken(this.longBucket);
          return null;
        }

        if (shortWait > 0 && longWait > 0) {
          return {
            waitMs: Math.max(shortWait, longWait),
            bucket: "short+long",
          };
        }

        if (shortWait > 0) {
          return { waitMs: shortWait, bucket: "short" };
        }

        return { waitMs: longWait, bucket: "long" };
      });

      if (!waitState) {
        return;
      }

      console.log(
        `[RateLimiter] Waiting ${waitState.waitMs}ms (bucket: ${waitState.bucket})`,
      );
      await sleep(waitState.waitMs);
    }
  }

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let retries = 0;

    while (true) {
      await this.acquireTokens();

      try {
        return await fn();
      } catch (error) {
        const isRiotRateLimitError =
          error instanceof RiotAPIError && error.status === 429;

        if (!isRiotRateLimitError) {
          throw error;
        }

        if (retries >= 3) {
          throw error;
        }

        retries += 1;
        const retryAfterSeconds = error.retryAfter ?? 1;
        const waitMs = Math.max(0, retryAfterSeconds * 1000);

        console.log(`[RateLimiter] Waiting ${waitMs}ms`);
        await sleep(waitMs);
      }
    }
  }

  async execute<T>(fn: () => Promise<T>, priority: RateLimitPriority = "high"): Promise<T> {
    if (priority === "high") {
      this.highPriorityInFlight += 1;
      try {
        return await this.executeWithRetry(fn);
      } finally {
        this.highPriorityInFlight = Math.max(0, this.highPriorityInFlight - 1);
      }
    }

    while (this.highPriorityInFlight > 0) {
      console.log("[RateLimiter] Waiting 100ms (bucket: high-priority queue)");
      await sleep(100);
    }

    return this.executeWithRetry(fn);
  }
}

export const riotRateLimiter = new RiotRateLimiter();
