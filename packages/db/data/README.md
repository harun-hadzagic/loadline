# cities.csv

1,000 of the most populous US places (contiguous 48 states plus DC) with coordinates, IANA time zone and population. Columns: `geoid,name,state,lat,lng,timezone,population`, sorted by population descending, lat/lng with 5 decimals.

## Source

US Census Bureau TIGERweb REST service (a US government work, public domain), accessed 2026-11-11. Population is the 2020 Census count (`POP100`); coordinates are the TIGER internal points (`INTPTLAT`, `INTPTLON`).

Service: https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/Places_CouSub_ConCity_SubMCD/MapServer

- Layer 4, Incorporated Places: `where=POP100>25000`
- Layer 3, Consolidated Cities: `where=POP100>0`
- Fields: `GEOID, STATE, PLACE (layer 4) / CONCITY (layer 3), BASENAME, NAME, LSADC, FUNCSTAT, POP100, INTPTLAT, INTPTLON`; `returnGeometry=false`, `f=json`.

The Census Gazetteer places file (2024_Gaz_place_national.zip) and the population estimates file (sub-est2024.csv) were the first choice, but www2.census.gov was unreachable (HTTP 403) from the build environment, so TIGERweb was used instead. Population is therefore the 2020 census count, not a 2024 estimate.

Raw JSON responses are cached in `data/raw/` (gitignored); delete them to refetch.

## Rules

- Only active governments (`FUNCSTAT` A, B, C). AK, HI, PR and territories are dropped.
- Rows from both layers are merged on GEOID, keeping the larger `POP100` (so Nashville, Indianapolis, Louisville, Augusta and Athens use the consolidated-government totals).
- Names are cleaned from `NAME` (legal suffixes such as "city", "town", "CDP", "(balance)", "metro government", "urban county" removed; consolidated names like "Nashville-Davidson metropolitan government" cut to "Nashville"; "San Buenaventura (Ventura)" becomes "Ventura"). Hyphens in names like "Winston-Salem" are kept.
- Deduplicated by (clean name, state) keeping the larger population, then the top 1,000 are kept.

## Time zones

State default, with overrides for split states in `scripts/timezones.ts`: FL panhandle (lng < -85.1) Central; El Paso area (lng < -105.5) Mountain; Idaho panhandle (lat > 45.5) Pacific; Malheur County OR (lng > -117.3, lat < 44.5) Mountain; western NE/KS/SD and southwest ND Mountain; western KY, northwest/southwest IN and western UP of MI Central (by place name); East Tennessee (lng > -85.35) Eastern. Arizona is `America/Phoenix` (Navajo Nation ignored).

## Rebuild

```
node packages/db/scripts/build-cities.ts
```
