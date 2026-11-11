# 0009 · Policies apply to `loadline_owner` too, with two narrow exceptions

**Date:** 2026-11-11 · **Phase:** 1

## Context

With `FORCE ROW LEVEL SECURITY`, the table owner is subject to policies. Policies can name roles (`TO loadline_app`), in which case the owner, having no policy, sees nothing at all. Two things need to cross companies: resolving an organization to its company before any company is set, and pruning outbox rows older than 24 hours for every company.

## Decision

The base `tenant_isolation` policy applies to every role (no `TO` clause), including `loadline_owner`. The seed therefore runs through `withTenant` as `loadline_app`, which means it passes the same policies as the application. A test checks the owner sees no tenant rows without a company set.

Two explicit, narrow exceptions, both in `0003_rls.sql` where a reviewer can read them:

1. `owner_resolves_companies`: `FOR SELECT TO loadline_owner USING (true)` on `app.companies` only, so `app.company_for_org()` (a `SECURITY DEFINER` function owned by `loadline_owner` with a fixed `search_path`, returning only the id) can do its one job. `loadline_owner` never logs in from the app.
2. `prune_old_events`: `FOR DELETE TO loadline_app USING (created_at < now() - interval '24 hours')` on `app.outbox`, so the app's cleanup job can delete rows that are already too old to replay, for every company, without a second role or connection.

## Rejected

- Policies `TO loadline_app` only: the owner would see every row under `FORCE`, so mistakes in seeds or jobs run as the owner would not surface.
- A `loadline_jobs` role with `BYPASSRLS` for pruning: one more credential for one bounded `DELETE`.
- Resolving organizations in the auth schema instead: `companies.org_id` is the one link between the two schemas and it belongs with the company.
