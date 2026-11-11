import { describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { clientKey, RateLimiter } from "@/server/rate-limit";

describe("RateLimiter", () => {
  it("allows `limit` requests per window, then answers 429 with a Retry-After hint", () => {
    let now = 1_000_000;
    const l = new RateLimiter({ limit: 3, windowMs: 60_000 }, () => now);
    expect(l.take("a").remaining).toBe(2);
    expect(l.take("a").remaining).toBe(1);
    expect(l.take("a").remaining).toBe(0);
    const err = (() => {
      try {
        l.take("a");
      } catch (e) {
        return e as AppError;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err?.status).toBe(429);
    expect(err?.details?.retryAfterSeconds).toBe(60);
    // Other keys are unaffected; the window resets.
    expect(l.take("b").remaining).toBe(2);
    now += 60_001;
    expect(l.take("a").remaining).toBe(2);
  });

  it("forgets expired buckets", () => {
    let now = 0;
    const l = new RateLimiter({ limit: 1, windowMs: 1_000 }, () => now);
    for (let i = 0; i < 100; i++) l.take(`k${i}`);
    expect(l.size()).toBe(100);
    now += 2_000;
    l.take("fresh");
    expect(l.size()).toBe(1);
  });

  it("keys sign-in attempts by the proxy's forwarded address", () => {
    process.env.TRUST_PROXY = "1";
    expect(
      clientKey(
        new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } }),
      ),
    ).toBe("203.0.113.9");
    expect(clientKey(new Request("http://x", { headers: { "x-real-ip": "198.51.100.2" } }))).toBe(
      "198.51.100.2",
    );
    expect(clientKey(new Request("http://x"))).toBe("local");
    // Without a trusted proxy the forwarded header is the client's word and is ignored.
    process.env.TRUST_PROXY = "";
    expect(
      clientKey(new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.9" } })),
    ).toBe("local");
  });
});
