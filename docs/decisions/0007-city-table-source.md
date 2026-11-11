# 0007 · The city table from TIGERweb instead of the Gazetteer files

**Date:** 2026-11-11 · **Phase:** 1

## Context

The spec says to build the city table from the Census Gazetteer places file (coordinates) joined with the population estimates file. From the build environment both `www2.census.gov` and `api.census.gov` returned HTTP 403 from Cloudflare for every URL tried (plain `curl` and Node `fetch`, no header tricks).

## Decision

Use the Census Bureau's TIGERweb REST service, which answered normally: the `Census2020/Places_CouSub_ConCity_SubMCD` MapServer, layer 4 (incorporated places) and layer 3 (consolidated cities). It returns, per place, the GEOID, the base name, the 2020 Census population (`POP100`) and the TIGER interior point (`INTPTLAT`, `INTPTLON`). Same bureau, same public-domain status, same GEOIDs; the population is the 2020 decennial count rather than the 2024 estimate.

`packages/db/scripts/build-cities.ts` fetches both layers (raw responses cached under the gitignored `data/raw/`), keeps active governments (`FUNCSTAT` A, B, C), drops Alaska, Hawaii and Puerto Rico, dedupes by (clean name, state), takes the 1,000 most populous and writes `data/cities.csv` (committed, 1,000 rows, the 1,000th being Cape Girardeau, MO at 39,540). Names are cleaned of legal decorations ("Nashville-Davidson metropolitan government (balance)" becomes "Nashville"; "Boise City" becomes "Boise").

The GEOID is the table's primary key (`integer`), so the CSV is stable across rebuilds and the seed can name cities deterministically.

## Rejected

- Working around the block with browser-like headers: not appropriate, and the data is available through a front door.
- Shipping a hand-typed city list: unverifiable, and the spec asks for a reproducible script.
- A `uuid` key for cities: reference data with a stable natural key gains nothing from a random one.
