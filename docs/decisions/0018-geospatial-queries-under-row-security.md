# 0018 · Geospatial queries under row-level security

**Date:** 2026-11-11 · **Phase:** 6 (found while re-running the geo benchmark as the app role)

## Context

The Phase 4 benchmark ran the nearest-trucks query as a superuser with a literal point and showed the GiST index doing its job. The Phase 4 review asked for the benchmark to run the app's exact query as `loadline_app` with the company set, so that row security is part of the plan. That run showed no difference between "with index" and "without index": about 115 ms either way for the nearest query, and about 330 ms either way for a one-mile radius count.

Two separate causes, both visible in `EXPLAIN`:

1. **PostGIS functions are not `LEAKPROOF`.** On a table with row-security policies, PostgreSQL only lets a user-supplied condition run inside an index scan when the operator's function is marked leakproof, because an index condition is evaluated before the policy filters rows and a function that can raise an error on its input could reveal a hidden row. `st_dwithin`, `geography_overlaps` (`&&`), `geography_gist_consistent` and friends are all `proleakproof = false` in PostGIS 3.6, so `ST_DWithin(...)` under row security becomes a plain filter over every row of the company. The `<->` ordering operator is not a condition and is not affected.
2. **The ordering expression was not a constant.** The app's query took the pickup location from a CTE and ordered by `p.location <-> pickup.location`. A nested loop does not preserve the inner side's order, so the planner sorted all 100,000 rows by distance instead of walking the index in distance order, index or no index.

## Decision

- **Constants in.** `assignmentCandidates` reads the pickup point and the load's window once, then runs the nearest query with `ORDER BY p.location <-> $pickup::geography` and `a.period && $window::tstzrange`. Under row security that is an index-ordered scan on `truck_positions_location_idx` that stops after five rows; `bench/results/geo.json` records the new numbers, measured as `loadline_app` with the company set.
- **No radius sweeps in the app.** The arrival check (`app.record_position`) looks up one stop by id and tests `ST_DWithin` on that row; no index is involved and row security costs nothing there. The benchmark keeps the radius query as a documented case of what row security does to a PostGIS condition, with a third row showing the same query as a superuser for comparison.
- **PostGIS functions stay as shipped.** Nothing in the migrations marks them `LEAKPROOF`.
- **Two numbers, not one.** The README's geo table shows the row-security case and the bypass case side by side, with this record linked, so nobody reads the superuser figure as the product's figure.

## Rejected

- `ALTER FUNCTION ... LEAKPROOF` on the PostGIS functions: asserting a property of C code nobody here has audited. It is the usual workaround and it would make radius queries fast under row security, but if the assertion is wrong, a crafted geometry could reveal rows of another company through an error message, which is the one thing the whole design exists to prevent.
- A `BYPASSRLS` helper role (like the stream role) for geospatial reads: a second trust boundary around the hottest user-facing query, when a parameter order fixes the one query the product needs.
- Dropping `FORCE ROW LEVEL SECURITY` for the owner and running geo queries as the owner: the same thing with a different name (decision 0009 explains why the owner is subject to the policies).
- Leaving the benchmark on the superuser path: it measured the index, not the product, and the README would have shown a number no dispatcher ever sees.
