# 0004 · Temporal constraints over an application check

**Date:** 2026-11-11 · **Phase:** 1

## Context

A driver or a truck must never hold two assignments whose periods overlap. The application could query for overlaps before inserting, but two dispatchers assigning in the same second both see no overlap and both insert.

## Decision

PostgreSQL 18's `WITHOUT OVERLAPS` on `app.assignments`:

```sql
CONSTRAINT assignments_driver_no_overlap UNIQUE (driver_id, period WITHOUT OVERLAPS),
CONSTRAINT assignments_truck_no_overlap  UNIQUE (truck_id,  period WITHOUT OVERLAPS),
CONSTRAINT assignments_load_no_overlap   UNIQUE (load_id,   period WITHOUT OVERLAPS)
```

`btree_gist` lets the GiST index combine a `uuid` with a `tstzrange`. The index itself serialises concurrent writers: the overlap test opens two transactions, lets the second block on the first, commits the first and asserts the second fails.

Measured, not assumed: the violation raises SQLSTATE `23P01` (`exclusion_violation`) with the constraint name in `constraint` and the clashing window in `detail`. `OVERLAP_SQLSTATE` in `packages/db/src/errors.ts` carries that value and the test asserts it. The application maps it to `409 Conflict` naming the driver or truck.

Consequences the constraint forces on the data model: empty ranges are rejected, and the constraint cannot be partial, so an assignment that ends early is closed by cutting `period` to `now()`; if `now()` is at or before the lower bound the row is deleted and the outbox keeps the history.

## Rejected

- A `SELECT ... FOR UPDATE` plus overlap query in the application: racy without a table lock, and invisible to anyone reading the schema.
- An `EXCLUDE USING gist (driver_id WITH =, period WITH &&)` constraint: the same mechanism underneath, but `WITHOUT OVERLAPS` is the standard syntax and the spec names it.
- A trigger that checks overlaps: triggers see only committed rows unless they lock, so they reintroduce the race.
