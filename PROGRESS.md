# Progress

One entry per phase: what was built, and the evidence it works. Figures here are copied from command output in this repository, never typed from memory.

## Phase 1 · Schema and tenancy — done 2026-11-11

**Built**

- Apple Silicon check: `postgis/postgis:18-3.6` has no `linux/arm64` manifest, so `docker/postgis/` builds a native image (`pnpm db:image`, tag `loadline/postgis:18-3.6`, PostgreSQL 18.6 + PostGIS 3.6.4). Compose reads `POSTGIS_IMAGE` with the official tag as default. Decision 0001.
- pnpm workspace (`apps/*`, `packages/*`, `bench`, `e2e`), strict TypeScript 6.0.3, Biome 2.6.6, Vitest 5.1.0, Node 24. Decision 0002.
- `docker-compose.yml`: `db` (healthcheck, volume at `/var/lib/postgresql`), `db-test` (tmpfs, port 5433, `--profile test`), `migrate` (one shot: roles, migrations, city table, seed). `web` and `simulator` arrive with their phases.
- `packages/db`: four roles in `sql/bootstrap.sql`; migrations `0001_schema` (types, `uuidv7()` keys, every table under Data model, temporal constraints), `0002_triggers` (audit columns, immutable `company_id`, transition trigger with SQLSTATE `LL001` and version bump, `app.company_for_org`, `app.emit`), `0003_rls` (enable + force on every tenant table, `tenant_isolation` everywhere, driver restrictive policies, two narrow exceptions), `0004_grants`.
- `withTenant()` with transaction-local `set_config`, a Zod-validated context, and `companyIdForOrg()`.
- City table: `scripts/build-cities.ts` from Census TIGERweb (Gazetteer files were unreachable; decision 0007), `data/cities.csv` with 1,000 places, time zones per decision 0006.
- Seed: Acme Freight (Dallas, TX) and Blue Ridge Haulers (Charlotte, NC), each with owner, admin, two dispatchers, eight drivers (with deterministic user ids for the Phase 2 auth seed), ten trucks, twenty loads across all five states, stops, assignments and truck positions. Runs through `withTenant` as `loadline_app`.
- Tests: isolation (every tenant table × SELECT/UPDATE/DELETE/INSERT as the wrong company, empty reads with no company, pooled-connection reset, catalog checks, driver scope, stream/auth/owner role limits, resolver), overlap (driver, truck and load constraints, adjacency, empty range, early end, two concurrent transactions), transitions (all 20 status pairs, version bump, stale version, immutable company), withTenant, Drizzle-mirror-vs-catalog, and unit tests (range/EWKB parsing, CSV, city table, time zones, no raw database access outside `packages/db`).
- Subagent definitions in `.claude/agents/` (phase reviewer on Opus, mechanical workers on Sonnet and Haiku).

**Evidence**

- `pnpm --filter @loadline/db test` against a fresh `db-test`: `Test Files 8 passed (8) · Tests 119 passed (119)` (110 before the review, 119 after its fixes).
- `docker compose up --build db migrate` from nothing: migrate log ends with `applied 4, already applied 0`, `cities: 1000 rows`, `Acme Freight: seeded`, `Blue Ridge Haulers: seeded`, `migrate-1 exited with code 0`.
- Catalog query on the seeded database: all eight tenant tables `relrowsecurity = t, relforcerowsecurity = t`; `cities` and `load_transitions` `f, f`.
- Measured SQLSTATE for a `WITHOUT OVERLAPS` violation: `23P01`, constraint name in `constraint`; under RLS the detail only says "Key conflicts with existing key".
- `pnpm lint` and `pnpm typecheck` clean.

**Reviewer**: eleven findings (two high: raw pool exports, a forgeable and deletable outbox), all fixed and re-tested; details in `docs/building-with-ai.md`.

## Phase 2 · Auth, roles and the load lifecycle — done 2026-11-11

**Built**

- Better Auth 1.7.20 (email + password, organization plugin, Loadline's four roles through its access-control API) over the `loadline_auth` pool with `search_path = auth`; tables in migration `0005_auth_schema.sql`; the active organization is set at sign-in by a session hook. Decision 0011.
- Request context (`apps/web/src/server/context.ts`): session → organization → membership role → company (through `app.company_for_org`) → linked driver, passed to `withTenant`. One permission table (`src/lib/permissions.ts`) and one enforcement point (`assertCan`).
- Services: load create/edit with stops, transitions through one function that checks the role and lets the trigger check legality, assignment with the optimistic version check and a named 409 on overlap (looked up inside a savepoint because RLS hides the clashing key), unassign/cancel/deliver closing the open assignment, fleet CRUD for drivers and trucks, the driver's load list. Every mutation emits its outbox event through `emit()`.
- Pages: sign-in, loads list, new load (stops with local-time windows converted in the stop's zone), load detail with assign and action buttons, edit, fleet pages for admins (dialog forms), and the phone-sized driver page with Picked up / Delivered.
- Auth seed: 24 demo logins (`DEMO_PASSWORD`), two organizations, memberships.
- Tests: role matrix (every role × every action), service tests against the real database (concurrent assigns → one 409, named overlap, stale version with current state, unassign frees driver and truck, every transition × every role, a driver cannot act on another driver's load), and Playwright: sign-in per company, wrong password, driver on a Pixel 7 viewport sees exactly their two loads with no horizontal overflow and delivers one.

**Evidence**

- `pnpm test`: db `8 files, 119 tests passed`; web `2 files, 32 tests passed`.
- `pnpm --filter @loadline/e2e test`: `5 passed` (3 desktop, 2 phone).
- `pnpm --filter @loadline/web build`: standalone build, exit 0, all routes dynamic.
- `pnpm lint`, `pnpm typecheck`: clean.

**Reviewer**: see `docs/building-with-ai.md`.

## Phase 3 · Live board — done 2026-11-11

**Built**

- `OutboxReader` (`packages/db/src/stream.ts`): the single `LISTEN` connection with health checks and exponential reconnect, `readVisible` (the spec's xmin rule), `readCommitted` (committed rows plus the safe horizon), `latestCursor`/`oldestCursor`. `pruneOutbox()` job. Decisions 0012–0015.
- `EventHub` (`apps/web/src/server/stream/hub.ts`): one per process on `globalThis`; fan-out by company and driver audience; replay from `Last-Event-ID` under the same lock as live delivery; `resync` for pruned or malformed cursors; 15-second heartbeat, 5-second safety poll, 10-minute prune; `/api/events/stats` for diagnostics.
- `GET /api/events` (Node runtime, `text/event-stream`, `retry:` hint, `?after=` for manual reconnects). JSON routes: `GET/POST /api/loads`, `GET/PATCH /api/loads/:id`, `POST …/transition`, `POST …/assign`, `GET …/candidates`.
- Browser: `LoadlineStream` (status, de-duplication by row id, pause/resume test hook on `window.__loadlineStream`), `useEventStream` applying events to the TanStack Query cache by entity id and version, the board (`/board`) with five columns, dnd-kit drag from Open to Assigned, an assign dialog fed by the candidates query (free first, nearest trucks first), optimistic updates rolled back with the server's current state on a 409, and the connection indicator.
- Phase 2 review fixes (see `docs/building-with-ai.md`): `memberRole`, `app.end_assignment()`, `app.load_window()`, one membership per user, closed sign-up, active-only assignment, deactivation guard, validated ids, FK → 404, same-state 409s.
- Tests: cursor (out-of-order commits, exactly-once replay from every cursor and across page boundaries, eager delivery with the horizon, NOTIFY wake-up); two-browser Playwright tests (assign in one and see it in the other; cut the second's stream, three changes, restore, all three exactly once; two dispatchers assign the same load and one sees the conflict); service tests grew to 57.
- `bench/sync-latency.ts` and `bench/readme-tables.ts`.

**Evidence**

- `pnpm test`: db `9 files, 124 tests`; web `2 files, 57 tests`; all passing.
- `pnpm --filter @loadline/e2e test`: `8 passed`. `playwright test tests/board.spec.ts --repeat-each 10`: `30 passed (1.5m)`. Cursor test run ten times: `10/10`.
- `bench/results/sync-latency.json` (dev server, `next dev`, one machine): 50 clients, 200 writes at 4.97/s, 10,000 of 10,000 deliveries, 0 lost, p50 1.6 ms, p95 2.6 ms, p99 3.1 ms, max 4.1 ms from the write's response to the client's receipt. To be re-run against the standalone build in Phase 6 for the README.
- `pnpm lint`, `pnpm typecheck`: clean.

**Reviewer**: see `docs/building-with-ai.md`.
