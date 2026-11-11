# 0010 · A fifth database-level role, `system`, for service writes

**Date:** 2026-11-11 · **Phase:** 1

## Context

The spec names four application roles: owner, admin, dispatcher and driver. Some writes have no person behind them: the simulator's position reports through `POST /api/positions`, the outbox cleanup job, and the seed. They still run through `withTenant` with a company, so `app.role` needs a value.

## Decision

`withTenant` accepts `role: "system"` in addition to the four. The policies only ever ask "is this a driver?", so `system` behaves like a dispatcher at the database level; the application never grants it to a session. The positions endpoint authenticates the service token, resolves the truck's company, and runs as `system` with no user id. `updated_by` stays `NULL` for such writes, which is the honest answer.

## Rejected

- Running service writes as `dispatcher`: misattributes them to a human role in audit columns and policies.
- A separate database role for the simulator: positions are ordinary tenant writes and belong on the same path as everything else.
