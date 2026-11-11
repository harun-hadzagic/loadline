# 0011 · Better Auth set-up, role resolution and the app shell

**Date:** 2026-11-11 · **Phase:** 2

## Context

Phase 2 needed sign-in, four roles per company, and a way to turn a request into a `withTenant` context. Several small choices had no single obvious answer in the spec.

## Decisions

- **Better Auth 1.7.20 with the built-in Kysely adapter over the `loadline_auth` pool.** The pool's `search_path` is `auth`, so Better Auth's unqualified table names land in the auth schema and the role has no privileges on `app`. Its tables were generated once with `getMigrations()` from the real config, schema-qualified by hand, and committed as `0005_auth_schema.sql`; the app never alters the schema at run time. A unique index on `(organizationId, userId)` in `member` gives one role per person per company.
- **UUID ids everywhere (`generateId: "uuid"`).** Demo users and organizations get deterministic uuidv5 ids from readable names (`packages/db/src/ids.ts`), so the app seed, the auth seed and the tests agree without a lookup.
- **The active organization is set at sign-in** by a `session.create.before` hook that reads the user's first membership. A person belongs to one company in 0.1. Requests whose session predates the hook fall back to picking the first membership.
- **The role comes from the membership, read through `auth.api.getFullOrganization`,** which checks membership itself. `getActiveMember` was tried first and fails on the request that just set the active organization, because the session cookie has not been reissued yet.
- **One permission table, `apps/web/src/lib/permissions.ts`,** through Better Auth's access-control API: owner, admin, dispatcher, driver with Loadline's resources (`load`, `intake`, `fleet`, `board`, `map`, `company`) on top of the plugin's defaults. `assertCan()` in `src/server/authorize.ts` is the only enforcement point in server code, and pages call `can()` to hide what a role may not do. The role matrix test lists every allowed pair per role. Database policies keep drivers to their own loads regardless.
- **`system` role for service writes** (decision 0010) is never granted to a session; the seed and the positions endpoint use it.
- **Next.js: `cacheComponents: false`, `output: "standalone"`, `transpilePackages` for the workspace.** Every page is per-session and changes by the second; opting each one out of the new caching model would be noise without benefit. The event stream route needs one long-lived Node process, hence standalone and self-hosted (decision 0012 covers serverless).
- **shadcn/ui with the Base UI preset (`base-nova`),** the CLI's current default. Components compose with a `render` prop rather than `asChild`; generated files under `src/components/ui` are excluded from Biome.
- **Conflict handling.** The service layer maps SQLSTATE `23P01` to a 409 and, because row-level security hides the clashing key from the constraint error, looks the clash up inside a savepoint-protected transaction to name the driver or truck, the load and the window. Stale versions return a 409 carrying the current load so the client can show what changed.

## Rejected

- Session-level `SET` of the company on sign-in: it would survive across pooled requests, which is exactly what `withTenant` prevents.
- A `role` column on the auth `user` table: roles belong to the membership, and a person could hold different roles in different companies later.
- Next.js `authInterrupts` / `forbidden()`: still experimental; a plain component with a `data-testid` does the job.
