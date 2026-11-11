# 0008 · Hand-written SQL migrations with a Drizzle mirror

**Date:** 2026-11-11 · **Phase:** 1

## Context

The spec wants Drizzle ORM for typed access, SQL migrations reviewed by hand, policies declared beside the tables, and nothing that changes the schema at run time. `drizzle-kit` cannot express `WITHOUT OVERLAPS`, `FORCE ROW LEVEL SECURITY`, triggers, `SECURITY DEFINER` functions or custom SQLSTATEs, which is most of what makes this schema interesting.

## Decision

The SQL files in `packages/db/migrations/` are the source of truth and the thing a reviewer reads: `0001_schema.sql` (types, tables, temporal constraints), `0002_triggers.sql` (audit columns, the transition trigger, the resolver, `app.emit`), `0003_rls.sql` (every policy) and `0004_grants.sql`. A 40-line runner (`src/migrate.ts`) applies them in name order as `loadline_owner`, one transaction each, recorded in `meta.migrations` under an advisory lock, and then upserts the city table.

`packages/db/src/schema/index.ts` is a Drizzle mirror of those tables for typed queries, with custom column types for `geography(Point,4326)`, `tstzrange`, `xid8` and `uuid[]`. The database test `schema-mirror.test.ts` compares the mirror's column names with `information_schema` for every table so the two cannot drift silently.

Roles, extensions and schemas are created once by `sql/bootstrap.sql` as the superuser (`src/bootstrap.ts` applies the role passwords with `format('%L')`), because `CREATE ROLE` and `CREATE EXTENSION postgis` need privileges the owner does not have.

## Rejected

- `drizzle-kit generate` plus hand edits: the generated files would be edited anyway, and `drizzle-kit`'s journal adds a second source of truth.
- `drizzle-kit push`: changes the schema from a tool at run time, which the rules forbid.
- A full Drizzle-only schema with `pgPolicy`: cannot express the constraints that matter here.
