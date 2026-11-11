# 0005 · The stream role with `BYPASSRLS`

**Date:** 2026-11-11 · **Phase:** 1

## Context

The event stream holds the single `LISTEN` connection and fans events out to every company's boards. It has to read every company's outbox rows, which the base policy forbids for any role subject to row security.

## Decision

A dedicated role, `loadline_stream`, with `BYPASSRLS` and grants limited to `SELECT` on `app.outbox`. It cannot read or write any other table; the test `loadline_stream reads the outbox of every company but nothing else` tries every other tenant table and asserts `42501`, and also checks that `INSERT` and `DELETE` on the outbox are refused.

The outbox payloads are what the application chose to publish; they carry entity ids and versions, not whole rows, so the blast radius of this role is the event feed itself. The stream process filters by `company_id` and `audience` before anything reaches a browser.

## Rejected

- Running the listener as `loadline_app` with a company set per query: it would need one connection per company, and `LISTEN` is global anyway.
- A `SECURITY DEFINER` function owned by `loadline_owner` that reads the outbox: the owner is subject to `FORCE ROW LEVEL SECURITY` too (record 0009), so it would need its own bypass policy; a role with one grant is simpler to audit.
- Giving `BYPASSRLS` to `loadline_app`: defeats the whole design.
