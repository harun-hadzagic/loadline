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
