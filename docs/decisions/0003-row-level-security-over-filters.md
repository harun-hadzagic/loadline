# 0003 · Row-level security over filters in application code

**Date:** 2026-11-11 · **Phase:** 1

## Context

Loadline is multi-tenant: two companies share one database. The usual approach is a `WHERE company_id = $1` in every query. One missed clause leaks another company's loads, and nothing in a test suite notices until someone writes a test for that exact query.

## Decision

Every tenant table has `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, with one policy shape everywhere: `USING (company_id = app.current_company()) WITH CHECK (company_id = app.current_company())`. `app.current_company()` reads `app.company_id` from the transaction's settings and returns `NULL` when it is unset, so a query with no company sees nothing rather than everything.

The application sets the settings in exactly one place, `withTenant()` in `packages/db`, with `set_config(name, value, true)` so they die with the transaction and a pooled connection cannot carry them on. Only `packages/db` may import the driver; a Biome rule and a source-scanning test enforce it.

Drivers get a second, restrictive policy on `loads`, `stops` and `assignments`: when `app.role` is `driver`, only rows of loads assigned to `app.driver_id` are visible. Restrictive policies are ANDed with the base policy, so a bug in a query can widen nothing.

The isolation tests (`packages/db/test/db/isolation.test.ts`) run every tenant table through `SELECT`, `UPDATE`, `DELETE` and `INSERT` as the wrong company, read every table with no company set, check the pooled connection forgets the company, and read the catalog so a new table without forced RLS fails CI.

## Rejected

- Filters in application code: fails open on the first forgotten clause, and cannot be checked by a catalog query.
- One database or schema per tenant: operationally heavy for a small company's board, and it moves the isolation story out of the SQL a reviewer can read.
- Policies only on `loadline_app` (`TO loadline_app`): see record 0009; the owner would then be unrestricted under `FORCE`, which hides mistakes in seeds and jobs.

## Addendum (Phase 6): what the policies do not decide

Row security answers *which rows* a role may touch, not *which columns* or *which values*. The Phase 6 review showed a driver, limited by the restrictive `driver_scope` policies to their own loads and stops, could still rewrite a load's rate or a stop's appointment, or cancel the load, because the table grant is a plain `UPDATE`. Column-level grants would not express "status may change, but only forward", so migration 0010 adds a `BEFORE UPDATE` trigger (`app.limit_driver_writes`) that lets a non-staff role change only `status` on loads (to `in_transit` or `delivered`) and `arrived_at`/`departed_at` on stops, and makes `app.end_assignment` accept only `delivered` from a driver. The rule still lives in the database and `packages/db/test/db/driver-writes.test.ts` proves it as the driver role; the application never had to be trusted for it.

