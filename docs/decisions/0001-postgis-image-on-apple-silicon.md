# 0001 · The PostGIS image on Apple Silicon

**Date:** 2026-11-11 · **Phase:** 1

## Context

The spec pins `postgis/postgis:18-3.6`. `docker manifest inspect postgis/postgis:18-3.6` on 11 November 2026 lists only `linux/amd64` (plus an attestation manifest). On Harun's MacBook (Apple M2 Pro, Docker Desktop 28) the official tag would run under emulation, which works for development but makes benchmark numbers meaningless.

## Decision

Build a native `linux/arm64` image from the official `postgis/docker-postgis` Dockerfile for `18-3.6` (the last commit that carried that directory, `ba86273c`; upstream has since moved to `18-3.7`). The build context is committed under `docker/postgis/` with the upstream MIT licence, and `pnpm db:image` tags it `loadline/postgis:18-3.6`.

One change to the upstream Dockerfile: the `postgresql-18-postgis-3-scripts` package is pinned to the same `3.6.4+dfsg-2.pgdg13+1` version as the library. Unpinned, apt now picks the 3.7.0 scripts, and `CREATE EXTENSION postgis` fails with "extension scripts version 3.7.0 cannot use older library version 3.6.4". The first build hit exactly this.

Compose reads the image from `POSTGIS_IMAGE`, defaulting to the official tag, so a Linux or CI machine needs nothing extra. `.env.example` carries the Apple Silicon line commented out, and the README quick start says when to uncomment it.

Result: PostgreSQL 18.6 with PostGIS 3.6.4, native arm64, 236 MB.

## Rejected

- Running the amd64 image under emulation for everything: fine for the app, useless for the two benchmarks.
- Switching to `postgis/postgis:18-3.6-alpine` or `18-3.7`: the spec pins 3.6, and the alpine variant changes the base image for everyone.
- Building the image automatically from Compose: `build:` on the `db` service would shadow the official tag on every machine and slow every first start.
