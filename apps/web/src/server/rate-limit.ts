import { AppError } from "./errors";

/**
 * A fixed-window counter per key, in process memory. Enough for one web
 * process (decision 0015); a second replica would need a shared store. Keys
 * are what the caller chooses: an IP for sign-in, a user id for intake, the
 * service token's company for positions.
 */
export interface RateLimit {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    private readonly rule: RateLimit,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one request; returns what is left, or throws 429 with a Retry-After hint. */
  take(key: string): { remaining: number; resetAt: number } {
    const t = this.now();
    this.sweep(t);
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + this.rule.windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    if (b.count > this.rule.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((b.resetAt - t) / 1000));
      throw new AppError(429, `Too many requests. Try again in ${retryAfterSeconds} s.`, {
        retryAfterSeconds,
      });
    }
    return { remaining: this.rule.limit - b.count, resetAt: b.resetAt };
  }

  /** Drop expired buckets now and then so the map cannot grow without bound. */
  private sweep(t: number): void {
    if (t - this.lastSweep < this.rule.windowMs) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (b.resetAt <= t) this.buckets.delete(k);
  }

  size(): number {
    return this.buckets.size;
  }
}

type Globals = typeof globalThis & { __loadlineLimiters?: Map<string, RateLimiter> };

/** Named limiters shared across requests in this process (and across dev reloads). */
export function limiter(name: string, rule: RateLimit): RateLimiter {
  const g = globalThis as Globals;
  g.__loadlineLimiters ??= new Map();
  let l = g.__loadlineLimiters.get(name);
  if (!l) {
    l = new RateLimiter(rule);
    g.__loadlineLimiters.set(name, l);
  }
  return l;
}

/** The caller's address as the proxy reports it, or "local" when nothing is set. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "local";
  return request.headers.get("x-real-ip") ?? "local";
}

/** An operator override for one limit, so a test suite (or an office behind one address) can raise it. */
function fromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const LIMITS = {
  /** Sign-in attempts per address: 20 per 10 minutes (SIGN_IN_RATE_LIMIT overrides the count). */
  signIn: { limit: fromEnv("SIGN_IN_RATE_LIMIT", 20), windowMs: 10 * 60_000 },
  /** Intake extractions per user: 30 per 10 minutes (a live Claude call costs money). */
  intake: { limit: 30, windowMs: 10 * 60_000 },
  /** Position batches per company: 120 per minute (the simulator sends one every 3 seconds). */
  positions: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, RateLimit>;
