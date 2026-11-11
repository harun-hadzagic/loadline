# Building Loadline with AI

Per phase: what Claude Code wrote, what its independent reviewer caught, and where the AI was wrong. The README's "How this was built" section is drawn from here. The build ran unattended on 11 November 2026 with Claude Fable 5.1 as the main agent; reviewers ran on Claude Opus with a fresh context; mechanical work went to Sonnet and Haiku.

## Phase 1 · Schema and tenancy

**What Claude Code wrote.** Everything in `packages/db`: the bootstrap SQL, four migration files, `withTenant`, the Drizzle mirror with custom column types, the seed, the migration runner, 110 tests, Compose, the migrate image, the arm64 PostGIS build, and decision records 0001 to 0010. A Sonnet subagent wrote the city-table script and its time-zone rules from a brief.

**Where the AI was wrong, and how it was caught.**

- *PostGIS image.* The first native build installed the unpinned `postgresql-18-postgis-3-scripts` package, which apt resolved to 3.7.0 against the 3.6.4 library. The container started, but `CREATE EXTENSION postgis` failed in the test database's init log. Fixed by pinning the scripts package; the pin and the reason are in the Dockerfile.
- *Oregon time zone rule.* The brief given to the Sonnet subagent said "Ontario, OR is Mountain when longitude < −117.3". That is backwards: Ontario sits at −116.96, east of the line, and the rule as written would have put Eugene, Bend and Medford on Mountain time. The subagent noticed from the data, flipped the comparison and reported the deviation. The unit test now pins both Eugene and Ontario.
- *Boise.* The Census legal name is "Boise City"; the cleaning rule left it as is and the unit test for Idaho failed. Added a one-entry alias map.
- *`format()` with untyped parameters.* `SELECT format('ALTER ROLE %I ...', $1, $2)` fails with "could not determine data type of parameter"; the parameters need `::text` casts. Found on the first run of the bootstrap.
- *Generated columns in the isolation test.* The first version inserted a copied row with `SELECT *`, which tries to write the generated `company_id` on `companies` and the identity `id` on `outbox`, failing with `428C9` instead of the RLS error being tested. The test now builds the column list from `information_schema` excluding generated and identity columns.
- *Drizzle wraps driver errors.* `tx.execute` throws a `DrizzleQueryError` whose `cause` is the `pg` error; code that checked `err.code` on the wrapper missed it. `pgError()` in `src/errors.ts` unwraps the cause and everything uses it.
- *Biome 2.6.* `"recommended": true` is deprecated in favour of `rules.preset`, and the formatter will reformat Markdown unless told not to; it reflowed `SPEC.md` on the first `biome check --write`, which was reverted and excluded.
- *The Census download.* The build environment cannot reach `www2.census.gov` or `api.census.gov` (Cloudflare 403). Rather than spoof a browser, the script was switched to the TIGERweb REST service, which serves the same GEOIDs, coordinates and the 2020 count. Decision 0007 records the departure from the spec.

**What the reviewer caught.** The Opus reviewer ran the suite (green), then attacked the database by hand as `loadline_app` and as a driver. Eleven findings, all fixed before Phase 2:

1. *High: raw pool exports.* `@loadline/db` exported `appPool`, `createPool` and `createDb`, so app code could skip `withTenant` and neither the Biome rule nor the scan test would notice. They now live only under `@loadline/db/testing`, which Biome forbids in `apps/**` and the scan test checks for by name.
2. *High: the outbox was not append-only.* `loadline_app` had INSERT and DELETE on `app.outbox`, so any session could delete its company's live events, insert rows with a forged `txid` (never streamed) or `created_at` (never pruned), and squat on future identity values to make another company's `emit` fail with a duplicate key. Fix: the app has no privileges on the outbox; `app.emit` is `SECURITY DEFINER` with a fixed `search_path` (still under the owner's forced `tenant_isolation`), and the outbox has only SELECT and INSERT policies so nobody can UPDATE or DELETE a live row.
3. *Medium: the prune policy did not work.* A `DELETE ... WHERE created_at < ...` needs SELECT visibility of the rows, and `tenant_isolation` hid other companies' rows, so the only statement that pruned everything was a bare `DELETE FROM app.outbox` with a company set, which also wiped the caller's fresh events. Fix: `app.prune_outbox()` runs as the owner, whose extra outbox policies (SELECT and DELETE) are both limited to rows older than 24 hours; a test seeds old rows for both companies and proves the fresh ones survive.
4. *Medium: no company row could be updated.* In a `BEFORE` trigger the stored generated `company_id` is not computed yet, so the immutability check fired on every `UPDATE app.companies`. Fix: compare `id` on that table; a new test updates every table's own rows.
5. *Medium: a driver kept a load after it was taken away.* `driver_scope` matched ended assignments. Fix: the policies require `ended_reason IS NULL`; a test unassigns a driver and shows the load, its stops and updates vanish at once.
6. *Medium: drivers could read other drivers' outbox payloads and phone numbers, and write truck positions.* Fixed by the outbox grants above, a restrictive policy on `drivers` (own row only) and staff-only write policies on `truck_positions`.
7. *Low-medium: delete plus insert reset a delivered load to open with version 1, and `INSERT` accepted `version = 2147483647`.* Fix: a `BEFORE INSERT` trigger forces version 1, a restrictive policy lets only `system` insert loads in a state other than open, and only open or cancelled loads can be deleted.
8. *Low: the pooled-connection test used two different connections.* It now runs both halves on a one-connection pool and asserts the backend pid is the same.
9. *Low: test gaps.* Added: drivers cannot insert assignments or stops; cross-company child rows are rejected by the composite foreign keys; overlap via `UPDATE` of a period; own-row updates; pruning; no views in `app`.
10. *Low: `updated_by` kept the previous human's id on system writes and accepted a caller-supplied value.* It is now always `app.current_user_id()`.
11. *Low: assorted.* The role check was `IS DISTINCT FROM 'driver'`, which fails open on an unset role; it is now the allowlist `app.is_staff()`. Decision 0004 claimed the overlap `detail` names the window; under RLS it does not. `parseTstzRange` threw on `infinity`. Compose published both database ports on all interfaces; they are bound to loopback now. The spec's "at least one pickup and one delivery per load" had no database rule; a deferred constraint trigger enforces it at commit.

Held up under attack: isolation on every table with and without a company, `FORCE` and `row_security = off`, the generated `company_id`, upserts against another company's truck, `company_for_org`, the overlap constraints under `UPDATE`, instant ranges, infinite bounds and concurrent writers, all twenty transitions through `UPDATE`, `MERGE` and `ON CONFLICT`, and the grants of every role.

## Phase 2 · Auth, roles and the load lifecycle

**What Claude Code wrote.** Better Auth configuration and migration, the request context, the permission table, the load/fleet/driver services, server actions, all pages, the auth seed, the role-matrix and service tests, and the Playwright suite with its phone project.

**Where the AI was wrong, and how it was caught.**

- *Active organization.* The first context resolver set the active organization and then called `getActiveMember` on the same request; Better Auth answered "No active organization" because the session cookie had not been reissued. Caught by the first Playwright run (every signed-in page was a 500). Fixed with a sign-in hook plus `getFullOrganization`.
- *Arrays through drizzle's `sql` tag.* `${array}::uuid[]` hands pg a bare string (or expands to a tuple), so `emit` failed with "malformed array literal" and the driver page with "cannot cast type record to app.load_status[]". Both now pass a PostgreSQL array literal. Caught by the service tests and the driver e2e.
- *Zod 4 and `.partial()`.* `loadInputSchema.partial()` throws at import time when the schema has refinements, which took down every server action with a 500. The edit schema now derives from an unrefined base and re-applies the stop checks. Caught by the driver "Delivered" e2e. The first fix attempt was applied to the wrong text and silently did nothing; verifying the file afterwards is now part of the routine.
- *Base UI, not Radix.* The shadcn CLI's current default preset composes with `render` props; `asChild` does not exist. Type errors caught it.
- *Drivers and `board:read`.* `listLoads` demanded the board permission, which drivers lack, so the driver page threw. Permission checks moved to the pages; the service relies on row-level security for scope.
- *Test windows collided.* Service tests that assigned "a free driver" picked the same driver for overlapping future windows; each test load now has its own window.
- *Playwright projects.* The driver spec ran on both projects against one database, so the second run found the load already delivered; the desktop project now ignores it.

**What the reviewer caught.** Twelve findings, two of them high; all fixed in the Phase 3 commit:

1. *High: a role/company race.* The context read the organization from one session read and the role from a second (`getActiveMember`), so a person who belonged to two companies could switch the active organization between the reads and act in company A with company B's role; the reviewer proved it by creating trucks as a driver. Fix: the role is read for the exact `(user, organization)` pair in one query (`memberRole`), memberships with more than one role are refused, and a unique index makes one membership per user the rule in 0.1.
2. *High: a driver's "Delivered" never closed the assignment.* The close ran as the driver, whose restrictive policies on `assignments` silently matched zero rows, so the driver and truck stayed booked and the load stayed visible. Fix: `app.end_assignment()` (SECURITY DEFINER, allowed for staff or the holding driver). Getting it to work took three more database lessons: the owner was also under the staff-only policies (now `TO loadline_app`), a `FOR ALL` policy's `USING` is re-checked against the *new* row of an `UPDATE` that reads columns (so drivers now see their ended assignments too), and a future assignment is deleted rather than cut, which the first test did not expect.
3. *Medium-high: no reassignment after unassigning once the window opened.* The new period started at the pickup time and overlapped the closed row. Fix: `app.load_window()` starts at `GREATEST(pickup, now())`, used by assign, edit and the candidates query alike.
4. *Medium: open sign-up and unverified invitation acceptance.* `disableSignUp` and `requireEmailVerificationOnInvitation` are set.
5. *Medium: inactive drivers and trucks could be assigned, and a booked driver deactivated.* The insert now selects only active rows; deactivation is refused while an open assignment exists.
6. *Medium: test gaps.* Added a test that lets the database (not the pre-check) decide a race, role × service tests for every mutating service, a driver-delivery test that asserts `ended_reason` and the cut period, same-state transitions, and the reopened-window reassignment.
7. *Low:* multi-role memberships, `in` versus `Object.hasOwn`, same-state transitions bumping the version, a 500 for a session with no active organization, unvalidated ids in two actions and a page, a stale `current` in 409 payloads, a misleading overlap message for the load constraint, and two different period formulas. All fixed as suggested.

Held up: cross-company access through every Better Auth endpoint, member management limits, CSRF and cookie flags, tenant isolation in the services, the atomic version check, the cut semantics for started/future/ended assignments, and the driver page.


## Phase 3 · Live board

**What Claude Code wrote.** The outbox reader with the visibility-safe cursor (`packages/db/src/stream.ts`), the event hub with fan-out, replay, heartbeat, poll and prune, the SSE route, the browser stream client and TanStack Query integration, the board with drag-to-assign and optimistic rollback, the assignment candidates query, the JSON routes, the two-browser Playwright tests, the cursor test and the sync-latency benchmark.

**Where the AI was wrong, and how it was caught.**

- *The two-browser tests failed for a day's worth of wrong reasons before the right one.* The first suspect was the stream; it was innocent twice. (1) A reviewer agent was running the test suite against the same database, resetting it under the e2e run; the e2e now has its own database. (2) The spec's xmin rule stalled delivery whenever any transaction in the cluster was open, including the reviewer's; see decision 0013 for the fix. (3) The real bug: the assign dialog defaulted to the first driver who was free *now*, who was busy in the load's window, so the assignment failed with a 409 while the test read the optimistic card state. The dialog now asks the server for candidates free in the window, and the test waits for the server's version number.
- *Globals survive hot reloads.* Changing the hub did nothing until the dev server restarted, because the `globalThis` guard kept the old instance (which is exactly its job in production). Noted in the hub file.
- *Zod `.partial()` on a refined schema*, drizzle's array parameters, and a stale Turbopack module after adding an export each cost one failed run; all caught by the e2e suite.
- *The benchmark undercounted itself.* Events could reach a client before the writer had read its own HTTP response, so 13% were counted as stray. Writes are now registered before they are sent, and a receipt that beats the response is reported as such (none did).
- *Ten in a row.* Repeating the two-browser tests exhausted the free drivers (every test load had the same window) and then pushed cards off-screen; test loads now get their own windows and the board's columns scroll independently.

**What the reviewer caught.** _Appended after the Phase 3 review._
