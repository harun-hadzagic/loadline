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

## Phase 4 · Map and geospatial — done 2026-11-11

**Built**

- `app.record_position()` (migration 0007): upsert of the truck's latest position, stale reports ignored, and the arrival check in the same transaction (`ST_DWithin` against the company's `arrival_radius_miles`, next open stop only, status untouched). Decision 0016.
- `POST /api/positions` and `GET /api/simulator/state` behind a constant-time service token; `recordPositions` emits one `position.updated` per truck and `stop.arrived` (addressed to the driver) per arrival; `GET /api/positions` for the map.
- `apps/simulator`: great-circle movement at 55 mph × `SIMULATOR_SPEED_FACTOR` toward the next open stop, jitter at home otherwise, one batch per company per tick; Compose service.
- `/map`: MapLibre GL with OpenFreeMap tiles, trucks coloured by state, stops of active loads, popups, live updates from `position.updated` payloads; works without the base map.
- Nearest free trucks in the assign dialog (`assignmentCandidates`: free in `app.load_window`, ordered by `location <-> pickup` on the GiST index).
- `bench/src/geo.ts`: a separate `loadline_bench` database with 100,000 trucks and 200,000 stops over the city table, `EXPLAIN (ANALYZE, BUFFERS)`, median of 20 runs after 3 warm-ups, indexes dropped and recreated for the comparison.
- Compose: `web` (standalone Next.js image) and `simulator` images; `docker compose up` brings up db → migrate → web → simulator.
- Phase 3 review fixes in the stream (see `docs/building-with-ai.md`): single-snapshot reads, one horizon per drain, per-frame resume ids, prune watermark, closed streams on failure, cache bridge per tab with refetch on hello, one-load rollback, event counting in the bench, `instrumentation.ts` starting the hub at boot.

**Evidence**

- `pnpm test`: db `11 files, 132 tests`; web `5 files, 67 tests` (hub, events, positions, services, permissions); simulator `4 tests`; all passing.
- `pnpm --filter @loadline/e2e test`: `11 passed` (auth, two-browser board, map with a live marker move, arrival on the load page, driver phone). `board.spec.ts --repeat-each 10`: `30 passed`.
- `bench/results/geo.json` (native arm64 image, Apple M2 Pro), re-measured in Phase 6 as the app role under row security after the review: nearest free trucks 0.805 ms with the GiST index (Index Scan on `truck_positions_location_idx`) vs 49.6 ms without (sort over a sequential scan). A one-mile radius count under row security does not use the index at all (322.9 ms with, 327.0 ms without: PostGIS functions are not `LEAKPROOF`); the same query as a superuser is 0.123 ms vs 125.8 ms. Decision 0018. The Phase 4 figures (0.075 ms vs 40.5 ms; 0.119 ms vs 133.6 ms) were measured as a superuser with a literal point and are superseded.
- `bench/results/sync-latency.json`, now against the production (standalone) build in Compose: 50 clients, 200 writes at 4.97/s, 10,000 of 10,000 delivered, 0 lost, 0 duplicates, p50 2.4 ms, p95 4.1 ms, p99 6.3 ms, max 8.5 ms.
- Simulator against the dev server at 600×: 3 trucks moving, 6 arrivals logged (3 loads × 2 stops), the rest idle at home as designed.
- `docker compose up --build`: all four services up, web healthy, sign-in and board 200. Note: this machine has a PostgreSQL on 5432, so the local `.env` uses `DB_PORT=5434`; `.env.example` keeps 5432.
- `pnpm lint`, `pnpm typecheck`: clean.

**Reviewer**: see `docs/building-with-ai.md`.

## Phase 5 · Load intake — done 2026-11-11

**Built**

- `packages/intake`: one Zod schema with a matching JSON Schema (`src/schema.ts`), 60 synthetic rate confirmations with expected answers in `fixtures/` (8 with prompt-injection attempts; a Sonnet subagent wrote them from a brief, `scripts/check-fixtures.ts` validates them), the regex baseline (`src/baseline.ts`), the Claude extractor (`src/claude.ts`: `claude-haiku-5-5`, `output_config.format` with the JSON schema, a random nonce around the document, data-not-instructions prompt, Zod re-validation, one retry, baseline fallback with a notice, cost from `usage` and the 10 November 2026 price table), the scorer (`src/eval/score.ts`) and the eval runner (`pnpm eval:intake`, `--extractor claude --live` with a key check, a printed estimate and a $1 hard cap). Decision 0017.
- `/loads/new`: paste, Extract, review the pre-filled form (cities matched against the bundled table, single appointment times widened to one hour with a warning, other references in the notes), Create. Says which extractor answered; uses the baseline when no key is set. 20,000-character cap in the box and in the server action.
- Hand-written Claude response fixtures in `packages/intake/fixtures-claude/` (labelled `.hand-written.json`): a valid answer, prose, a schema violation.

**Evidence**

- `bench/results/intake-baseline.json` (`pnpm eval:intake`, re-run after the Phase 5 review fixes): regex baseline over 60 documents, whole-document 38.3%, field 85.6% (loadReference 100%, rateUsd 100%, equipment 100%, commodity 93.3%, brokerName 90%, weightLbs 85%, stops 61.7%, otherReferences 55%); injection: 5 of 8 fully correct, rate untouched in all 8, weight in 7, reference in 8, equipment in 8, stops in 5. The baseline was tuned on these documents, so this is an upper bound for these layouts, not a general figure. Before the review fixes it scored 33.3% / 84.6%. Claude: not measured in this build (no key, no calls).
- `pnpm --filter @loadline/intake test`: `4 files, 24 tests` (fixtures and injection flags, date and window parsing including four-digit ranges, next-line times, street numbers and impossible dates, baseline floor, injection resistance and hostile input, the Claude extractor through the fake client: valid, retry, truncation retry, refusal, client error, lenient repairs, fallback, tag forgery and nonce uniqueness; JSON-schema parity; no static SDK import, no `fetch`, no key in the test environment).
- `pnpm --filter @loadline/e2e test`: `13 passed`, including paste → pre-filled form → create for fixture 001 and the 20,000-character cap.
- No test, script, page or build calls the Anthropic API: `liveMessagesClient()` is the only place the SDK is imported, lazily, and it throws without a key.
- `pnpm test` elsewhere unchanged: db `132`, web `67`, simulator `4`.

**Reviewer**: see `docs/building-with-ai.md`.

## Phase 6 · Hardening, docs and release prep — done 2026-11-11

**Built**

- The Phase 4 review fixes: migration 0009 (stale reports ignored entirely, future reports clamped, late trucks arrive, `app.load_window` never inverts), the hub's backlog rule (a slow client is closed, never fed gaps; `hub-backlog.test.ts`), the reader keeping its snapshot only after a successful read, rate limits on sign-in, intake and positions with a `SIGN_IN_RATE_LIMIT` override, security headers and a content security policy, digest-based service-token comparison, the sync benchmark registering writes before sending them, a direct test for the five-nearest-trucks query. Decision 0019.
- The geospatial fix the re-run benchmark forced: the nearest-trucks query takes the pickup point and the load's window as constants, so the GiST index serves it under row security; the benchmark runs that exact query as `loadline_app` and reports the radius case honestly. Decision 0018.
- The Phase 5 review fixes: nonce-named wrapper tags with escaping of look-alikes, no silent city substitution, date-only stops left for the dispatcher, baseline time parsing anchored to the date, the baseline never throwing, the year as a parameter, live-path error handling (timeout, retries, refusal, truncation, partial results), lenient repairs before validation, MC numbers beyond the issued range, per-field injection reporting, a unit test for the server-side cap.
- CI (`.github/workflows/ci.yml`): checks and end-to-end jobs, least-privilege permissions, actions pinned to commit SHAs, a PostGIS service container, the baseline eval re-run for reproducibility.
- `README.md` with the three generated tables (`pnpm --filter bench readme`), the quick start and demo logins, the architecture diagram, the five questions, limits, how it was built, and the `TODO(Harun)` paragraph left for Harun. `docs/media/two-browsers.gif` (4.46 MB, 22 s) recorded by `pnpm gif` against the Compose stack's production build. `HANDOFF.md`.

**Evidence**

- `pnpm test` (clean test database): db `11 files, 135 tests`, intake `4 files, 24 tests`, simulator `4 tests`, web `9 files, 78 tests`; all passing. `pnpm lint`, `pnpm typecheck`: clean.
- `pnpm e2e` against the dev server: `13 passed`; `board.spec.ts --repeat-each 10`: `30 passed`.
- `docker compose up -d --build web simulator` on the existing stack: migration 0009 applied by the `migrate` service, web healthy, simulator running, sign-in and board 200 on the production build.
- `bench/results/sync-latency.json`, production build, after the hub rework: 50 clients, 200 writes at 4.97/s, 10,000 of 10,000 delivered, 0 lost, 0 duplicates, 0 stray, p50 2.5 ms, p95 4.4 ms, p99 7.4 ms, max 31.5 ms.
- `bench/results/geo.json`, as the app role under row security: nearest free trucks 0.805 ms with the index vs 49.6 ms without; radius count 322.9 ms vs 327.0 ms (no index use: PostGIS functions are not `LEAKPROOF`); the same radius query as a superuser 0.123 ms vs 125.8 ms.
- `bench/results/intake-baseline.json`: whole-document 38.3%, field 85.6% over 60 documents; Claude not measured.
- Nothing pushed, tagged, deployed or published; no Anthropic API call was made at any point.

**Reviewer**: see `docs/building-with-ai.md`.
