# 0006 · The state-to-time-zone approximation

**Date:** 2026-11-11 · **Phase:** 1

## Context

Appointment times are shown in the stop's local zone, and a stop resolves to a city in the bundled table. Thirteen states span two zones. A proper answer needs a time-zone boundary dataset; 0.1 does not ship one.

## Decision

Each city gets one of five IANA zones (`America/New_York`, `America/Chicago`, `America/Denver`, `America/Phoenix`, `America/Los_Angeles`) from a state default plus documented overrides in `packages/db/scripts/timezones.ts`:

- **Florida** west of the Apalachicola (longitude < −85.1) is Central: Pensacola, Panama City, Crestview.
- **Texas** west of −105.5 is Mountain: El Paso, Socorro, Horizon City.
- **Idaho** north of 45.5 is Pacific: Coeur d'Alene, Post Falls, Lewiston, Moscow.
- **Oregon**: Ontario (Malheur County, east of −117.3 and south of 44.5) is Mountain.
- **Nebraska** west of −101.5, **Kansas** west of −101.3, **South Dakota** west of −101.0 are Mountain; **North Dakota** south of 47 and west of −102 (Dickinson) is Mountain.
- **Tennessee** defaults to Central; east of −85.35 (Knoxville, Chattanooga, the Tri-Cities, Cleveland) is Eastern.
- **Kentucky** defaults to Eastern; a named list of western places (Bowling Green, Owensboro, Paducah, Hopkinsville, Henderson…) is Central.
- **Indiana** defaults to Eastern; named places in the northwest (Gary, Hammond, Valparaiso…) and southwest (Evansville, Princeton…) corners are Central.
- **Michigan** defaults to Eastern; four western Upper Peninsula counties' towns (Ironwood, Iron Mountain, Menominee…) are Central.
- **Arizona** is `America/Phoenix` throughout; the Navajo Nation observes DST but has no top-1,000 place.

Among the 1,000 places this yields 14 overrides, all listed in `packages/db/data/README.md`. The unit test `cities.test.ts` pins the well-known cases.

Where it is wrong: a county-line boundary is approximated by a straight longitude or a short list, so a small town near a zone line can be off by an hour. For a dispatch board whose stops are major cities this is acceptable; a 0.2 item is to use a zone-boundary dataset or geocoding.

## Rejected

- A time-zone polygon dataset: another 100 MB download and a PostGIS join for a problem that affects a handful of rows.
- Per-state only, with no exceptions: El Paso and Pensacola would be wrong, and both are real freight lanes.
