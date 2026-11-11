# 0002 · Library versions at install time

**Date:** 2026-11-11 · **Phase:** 1 (updated as later phases add packages)

## Context

The spec asks for the latest stable release of each library at install time, two versions pinned on purpose (PostgreSQL 18 with PostGIS 3.6, and Next.js 16), and the lockfile committed.

## Decision

Versions resolved on 11 November 2026 (`npm view <pkg> version`):

| Package | Version | Note |
| --- | --- | --- |
| Node.js | 24.22.1 (local) | `.node-version` says 24; Docker images use `node:24-bookworm-slim` |
| pnpm | 12.18.0 | `packageManager` field; pnpm 12 needs `allowBuilds` for postinstall scripts |
| TypeScript | **6.0.3** | see below |
| @biomejs/biome | 2.6.6 | |
| vitest | 5.1.0 | |
| pg | 8.23.1 | |
| drizzle-orm | 0.45.4 | |
| zod | 4.6.7 | |
| tsx | 4.23.15 | |
| next | 16.4.6 | added in Phase 2 |
| react / react-dom | 19.3.1 | Phase 2 |
| better-auth | 1.7.20 | Phase 2 |
| tailwindcss | 4.3.5 | Phase 2 |
| @tanstack/react-query | 5.107.1 | Phase 3 |
| @dnd-kit/core | 6.3.1 | Phase 3 |
| maplibre-gl | 6.17.0 | Phase 4 |
| @anthropic-ai/sdk | 1.8.0 | Phase 5; never called in this build |
| @playwright/test | 1.65.0 | Phase 3 |

**TypeScript 6.0.3, not 7.0.2.** TypeScript 7 is the native (Go) compiler. It is the latest stable, but Next.js's type plugin, Vitest's type checking and several libraries' type-level tricks were written against the JavaScript compiler, and TypeScript 6 is the designated bridge release with the same language semantics. The risk of a toolchain incompatibility mid-build outweighs the speed win. Moving to 7 is a 0.2 item.

## Rejected

- TypeScript 7.0.2: see above.
- `postgres` (postgres.js) instead of `pg`: the spec names `pg`, and `LISTEN` on a dedicated client is well trodden with `pg`.
