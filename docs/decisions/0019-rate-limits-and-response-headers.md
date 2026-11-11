# 0019 · Rate limits and response headers

**Date:** 2026-11-11 · **Phase:** 4 review

## Context

The Phase 4 review pointed out three routes with a cost and no brake: sign-in (password guessing), the intake action (with a live key every call costs money), and `POST /api/positions` (a leaked service token could flood the outbox). It also noted the app sent no security headers.

## Decision

- **A fixed-window limiter in process** (`apps/web/src/server/rate-limit.ts`): sign-in 20 per 10 minutes per client address, intake 30 per 10 minutes per user, positions 120 per minute per company. Over the limit the route answers `429` with `Retry-After`. The windows are generous for one dispatch office and tight for a script. The sign-in count can be raised with `SIGN_IN_RATE_LIMIT` for an office behind one address; the end-to-end suite sets it high because it signs in dozens of times in a few minutes, which is how the limit was first noticed: the first Phase 6 run failed every test after the twentieth sign-in.
- **Whose address?** `X-Forwarded-For` is whatever the client sent unless a reverse proxy overwrites it, and Next.js does not expose the socket address to route handlers. The limiter therefore reads forwarding headers only when `TRUST_PROXY` is set; without it every direct caller shares one bucket, which is correct for the Compose stack (bound to `127.0.0.1`) and visibly wrong, rather than silently bypassable, anywhere else. The bucket map is capped at 10,000 keys so a flood of invented addresses cannot grow it without bound. (The Phase 6 review found the first version trusted the header unconditionally.)
- **One limiter, not two.** Better Auth ships its own in-memory limiter, on by default in production, keyed on the same forwarded header. It is turned off (`rateLimit: { enabled: false }` in `apps/web/src/lib/auth.ts`) so a sign-in is counted once, against one documented window.
- **Headers in `next.config.ts`**: a Content Security Policy that allows the app's own scripts and styles, the OpenFreeMap tile host, and the event stream; `'unsafe-eval'` only in development, where Next.js needs it; `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and no `X-Powered-By`.
- **The service token** is compared as SHA-256 digests with `timingSafeEqual`, so a token of the wrong length is rejected in the same time as a wrong token of the right length.

## When it stops being enough

The limiter's counters live in the web process. With one web process (the Compose stack, decision 0015) that is exact; with several behind a load balancer each process counts on its own, so the effective limit multiplies by the process count. The step up is a counter in PostgreSQL (one `UPDATE ... RETURNING` per request on a small table) or in a shared cache, behind the same `limiter()` call.

## Rejected

- A reverse proxy's rate limiting only: nothing in this build runs one, and the intake limit is per user, which the proxy does not know.
- Better Auth's own rate limiting as the sign-in limiter: it covers sign-in but not the other two routes, trusts the forwarded header, and one mechanism is easier to reason about than two. It is disabled rather than left running alongside.
