# HANDOFF

## Final test-suite result

`pnpm test` on a clean test database, 11 November 2026, after the last commit of the build run:

| Suite | Result |
| --- | --- |
| `@loadline/db` (real PostgreSQL: isolation, driver writes, overlap, transitions, cursor, positions, schema mirror) | 12 files, **138 passed** |
| `@loadline/intake` (baseline including the whitespace stress test, Claude extractor through a fake client, schema, no-network) | 4 files, **25 passed** |
| `@loadline/simulator` | 1 file, **4 passed** |
| `@loadline/web` (hub, events, positions, services, permissions, rate limit, intake, draft) | 9 files, **78 passed** |
| `pnpm e2e` (Playwright, desktop and phone, against a dev server) | **13 passed**; `board.spec.ts --repeat-each 10`: **30 passed** |
| `pnpm lint`, `pnpm typecheck` | clean |

Nothing was pushed, tagged, deployed or published, and no Anthropic API call was made at any point in the build.

## Run it locally

Prerequisites: Docker, Node.js 24 or later, pnpm 12 (`corepack enable`), and ffmpeg only if you re-record the GIF.

```sh
cp .env.example .env
docker compose up              # db → migrate (bootstrap, migrations, seed) → web → simulator
open http://localhost:3000     # logins in README.md, password loadline-demo
```

On Apple Silicon run `pnpm db:image` first and set `POSTGIS_IMAGE=loadline/postgis:18-3.6` in `.env` (decision 0001). If a PostgreSQL already listens on 5432, change `DB_PORT` and the five `DATABASE_URL_*` lines together; this machine's `.env` uses 5434 for that reason, `.env.example` keeps 5432.

Tests and measurements, outside Docker:

```sh
pnpm install
pnpm db:test:up                                  # tmpfs PostGIS on 5433
pnpm test                                        # every unit and database suite
pnpm e2e                                         # starts its own dev server on 3131
pnpm eval:intake                                 # regex baseline → bench/results/intake-baseline.json
BENCH_BASE_URL=http://localhost:3000 pnpm bench:sync      # needs the Compose stack up
BENCH_DATABASE_URL_SUPER=postgres://postgres:postgres-local@localhost:5433/loadline_bench pnpm bench:geo
pnpm --filter bench readme                       # regenerates the README tables from bench/results
pnpm gif                                         # re-records docs/media/two-browsers.gif (see e2e/scripts/record-gif.ts)
```

The database suites each reset their database; run them against a database nothing else is using. The stream tests are sensitive, by design, to long-open transactions from other sessions on the same cluster. Two things about `pnpm e2e`: Next.js refuses to start a second `next dev` in `apps/web`, so stop any running dev server first; and because Playwright reuses an existing server on its port, make sure nothing else is listening on 3131 (or set `E2E_PORT`), or the suite would run against whatever database that server points at.

## The three results

All from `bench/results/`, Apple M2 Pro, 11 November 2026.

- **Sync latency** (`sync-latency.json`, production build in Compose): 50 SSE clients, 200 writes at 4.97/s, 10,000 of 10,000 events delivered, 0 lost, 0 duplicates; p50 2.5 ms, p95 4.4 ms, p99 7.4 ms, max 31.5 ms.
- **Geospatial** (`geo.json`, 100,000 trucks and 200,000 stops, as `loadline_app` with row security on): the five-nearest-free-trucks query 0.805 ms with the GiST index vs 49.587 ms without. A one-mile `ST_DWithin` count under row security 322.879 ms vs 326.973 ms, that is, no index use at all, because PostGIS functions are not `LEAKPROOF`; the same query as a superuser 0.123 ms vs 125.828 ms. Decision 0018 explains it; the product runs no radius sweeps.
- **Intake** (`intake-baseline.json`): regex baseline over 60 synthetic documents, field accuracy 85.6%, whole-document accuracy 38.3%; 5 of the 8 injected documents fully correct, the rate untouched in all 8. The baseline was tuned on these documents, so this is an upper bound for these layouts. **Claude: not yet measured.**

## Harun's steps, in order

1. **Create the GitHub repository and push `main`.** The local clone already has `origin` set to `https://github.com/harun-hadzagic/loadline.git` (the README badge uses that owner); the repository itself does not exist yet. Create it empty on GitHub (no README, no license), then:
   ```sh
   git push -u origin main
   ```
   If you choose another owner or name, change the remote and the badge URL in `README.md` first.
2. **Check the first CI run** (Actions → CI). Two jobs: `checks` (lint, typecheck, every unit and database suite against a PostGIS service container, and the baseline eval re-run so the committed result is reproducible) and `e2e` (Playwright against its own dev server). The workflow has never run; expect a first-run fix or two (the pnpm version through corepack, the Playwright browser install step, the web server start-up timeout are the usual ones). The actions are pinned to commit SHAs; bump them deliberately.
3. **Run the live intake eval with a key and commit its result.**
   ```sh
   export ANTHROPIC_API_KEY=sk-ant-...
   pnpm eval:intake --extractor claude --live     # prints an estimate, refuses above the $1 hard cap, stops at $1
   pnpm --filter bench readme                     # fills the Claude row in the README table
   git add bench/results/intake-claude.json README.md && git commit
   ```
   Read `fallbacks` in the result file: `error` counts documents where the API call itself failed (a wrong request shape would show up here, since this build never made a real call), `validation` where the answer did not fit the schema twice, `refusal` where the model declined. A result marked `partial` stopped early; its `note` says why.
4. **Write the dispatch paragraph**: the `TODO(Harun)` block near the end of `README.md`.
5. **Tag v0.1.0**: `git tag -a v0.1.0 -m "Loadline 0.1.0" && git push --tags`.

## Known gaps

- **The Claude extractor has never been executed.** Its request (model `claude-haiku-5-5`, `output_config.format` with the JSON schema, GA `messages.create`, 60 s timeout, two SDK retries) follows the SDK 1.8.0 documentation; it is tested only through a fake client and hand-written response fixtures. If the API rejects something, every document falls back to the baseline with `fallbacks.error` counting it, and the eval result will say so rather than hide it.
- **CI has never run** (the remote repository does not exist yet). See step 2.
- **Member and driver-login management is not built.** Admins cannot invite a user, change a role, or link a driver row to a login from the app; all of that comes from the seed. The permission model (`apps/web/src/lib/permissions.ts`) already has `member` and `invitation` statements for admins and owners, so the screen is the missing part. Driver logins therefore only exist for the sixteen seeded drivers.
- **Sign-in rate limiting is by address only behind a proxy.** Without `TRUST_PROXY` every direct caller shares one bucket (decision 0019), which is right for the Compose stack bound to localhost; put a reverse proxy in front and set `TRUST_PROXY=1` before exposing it.
- **Radius queries under row security cannot use the GiST index** (decision 0018). Today nothing in the product needs one; a "stops near this truck" feature would need a different approach before it is built.
- **Fan-out and rate limiting are per process.** One web process is the deployment (decision 0015); a second replica needs a shared counter for the limiter and will read the outbox independently.
- **Row 3 of the geo table is a superuser figure**, shown for scale only; the README says so.
- **The intake fixtures are synthetic** and the baseline was tuned on them. Real rate confirmations will score lower; the Claude row is the one that matters and it is empty until step 3.
- **Custom agent definitions** in `.claude/agents/` (`phase-reviewer`, `mechanical-sonnet`, `mechanical-haiku`) could not be loaded as agent types in this session's Claude Code; the reviewers ran as general-purpose agents with the same model and effort overrides. The files are kept as the intended set-up; check they load in yours.
- **Development-server quirks seen once each**, neither in the production build: a hot-reload loop after `next.config.ts` was reformatted (a restart cleared it), and a MapLibre "Worker failed to load" console message under Turbopack while the map still rendered.
- **Demo passwords and tokens in `.env.example` are for local use only**, as the file says; nothing in the repository is a real secret.
