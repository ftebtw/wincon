import { logger } from "@/lib/logger";
import { RiotAPIError } from "@/lib/riot-api";

type BucketConfig = {
  capacity: number;
  windowMs: number;
};

type BucketState = BucketConfig & {
  tokens: number;
  lastRefillMs: number;
};

type BudgetBuckets = {
  short: BucketState;
  long: BucketState;
};

export type RateLimitPriority = "high" | "low";

const USER_SHORT_BUCKET: BucketConfig = {
  capacity: 14,
  windowMs: 1_000,
};

const USER_LONG_BUCKET: BucketConfig = {
  capacity: 70,
  windowMs: 120_000,
};

const BACKGROUND_SHORT_BUCKET: BucketConfig = {
  capacity: 6,
  windowMs: 1_000,
};

const BACKGROUND_LONG_BUCKET: BucketConfig = {
  capacity: 30,
  windowMs: 120_000,
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createBucketState(config: BucketConfig): BucketState {
  return {
    ...config,
    tokens: config.capacity,
    lastRefillMs: Date.now(),
  };
}

export class RiotRateLimiter {
  private readonly userBuckets: BudgetBuckets = {
    short: createBucketState(USER_SHORT_BUCKET),
    long: createBucketState(USER_LONG_BUCKET),
  };

  private readonly backgroundBuckets: BudgetBuckets = {
    short: createBucketState(BACKGROUND_SHORT_BUCKET),
    long: createBucketState(BACKGROUND_LONG_BUCKET),
  };

  private queue: Promise<void> = Promise.resolve();
  private highPriorityInFlight = 0;
  private isBackgroundPaused = false;

  constructor(private readonly label = "user") {}

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

  private refillBucket(bucket: BucketState): void {
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

  private refillAllBuckets(): void {
    this.refillBucket(this.userBuckets.short);
    this.refillBucket(this.userBuckets.long);
    this.refillBucket(this.backgroundBuckets.short);
    this.refillBucket(this.backgroundBuckets.long);
  }

  private consumePair(budgets: BudgetBuckets): void {
    budgets.short.tokens = Math.max(0, budgets.short.tokens - 1);
    budgets.long.tokens = Math.max(0, budgets.long.tokens - 1);
  }

  private canConsumePair(budgets: BudgetBuckets): boolean {
    return this.getWaitMs(budgets.short) === 0 && this.getWaitMs(budgets.long) === 0;
  }

  private evaluateBackgroundPause(): void {
    if (!this.isBackgroundPaused && this.highPriorityInFlight > 10) {
      this.isBackgroundPaused = true;
      logger.warn("Background collection paused due to user traffic spike.", {
        endpoint: "RiotRateLimiter",
        concurrentUserCalls: this.highPriorityInFlight,
        limiterLabel: this.label,
      });
      return;
    }

    if (this.isBackgroundPaused && this.highPriorityInFlight < 5) {
      this.isBackgroundPaused = false;
      logger.info("Background collection resumed after user traffic normalized.", {
        endpoint: "RiotRateLimiter",
        concurrentUserCalls: this.highPriorityInFlight,
        limiterLabel: this.label,
      });
    }
  }

  private async waitForBackgroundResume(): Promise<void> {
    while (true) {
      const paused = await this.withLock<boolean>(() => {
        this.evaluateBackgroundPause();
        return this.isBackgroundPaused;
      });
      if (!paused) {
        return;
      }
      await sleep(200);
    }
  }

  private async acquireTokens(priority: RateLimitPriority): Promise<void> {
    while (true) {
      const waitMs = await this.withLock<number | null>(() => {
        this.refillAllBuckets();
        this.evaluateBackgroundPause();

        if (priority === "high") {
          if (this.canConsumePair(this.userBuckets)) {
            this.consumePair(this.userBuckets);
            return null;
          }

          if (this.canConsumePair(this.backgroundBuckets)) {
            // User traffic can borrow from background budget.
            this.consumePair(this.backgroundBuckets);
            return null;
          }

          const userWait = Math.max(
            this.getWaitMs(this.userBuckets.short),
            this.getWaitMs(this.userBuckets.long),
          );
          const backgroundWait = Math.max(
            this.getWaitMs(this.backgroundBuckets.short),
            this.getWaitMs(this.backgroundBuckets.long),
          );
          return Math.min(userWait || Number.MAX_SAFE_INTEGER, backgroundWait || Number.MAX_SAFE_INTEGER);
        }

        if (this.isBackgroundPaused) {
          return 200;
        }

        if (this.canConsumePair(this.backgroundBuckets)) {
          this.consumePair(this.backgroundBuckets);
          return null;
        }

        return Math.max(
          this.getWaitMs(this.backgroundBuckets.short),
          this.getWaitMs(this.backgroundBuckets.long),
        );
      });

      if (waitMs === null) {
        return;
      }
      await sleep(Math.max(50, waitMs));
    }
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    priority: RateLimitPriority,
  ): Promise<T> {
    let retries = 0;

    while (true) {
      if (priority === "low") {
        await this.waitForBackgroundResume();
      }
      await this.acquireTokens(priority);

      try {
        return await fn();
      } catch (error) {
        const isRiotRateLimitError =
          error instanceof RiotAPIError && error.status === 429;

        if (!isRiotRateLimitError) {
          throw error;
        }

        logger.warn("Riot API 429 encountered by limiter.", {
          endpoint: "RiotRateLimiter.executeWithRetry",
          retries,
          limiterLabel: this.label,
          retryAfter: error.retryAfter,
          priority,
        });

        if (retries >= 3) {
          throw error;
        }

        retries += 1;
        const retryAfterSeconds = error.retryAfter ?? 1;
        await sleep(Math.max(0, retryAfterSeconds * 1000));
      }
    }
  }

  async execute<T>(
    fn: () => Promise<T>,
    priority: RateLimitPriority = "high",
  ): Promise<T> {
    if (priority === "high") {
      this.highPriorityInFlight += 1;
      try {
        return await this.executeWithRetry(fn, priority);
      } finally {
        this.highPriorityInFlight = Math.max(0, this.highPriorityInFlight - 1);
      }
    }

    return this.executeWithRetry(fn, priority);
  }
}

export const riotRateLimiter = new RiotRateLimiter("interactive");
export const backgroundRiotRateLimiter = new RiotRateLimiter("background");
