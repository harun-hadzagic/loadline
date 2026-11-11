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

**What the reviewer caught.** _Pending: the Phase 1 review runs after this entry is written; its findings and fixes are appended below._
