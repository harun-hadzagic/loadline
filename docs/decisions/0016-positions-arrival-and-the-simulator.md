# 0016 · Positions, automatic arrival and the simulator

**Date:** 2026-11-11 · **Phase:** 4

## Context

The map needs live truck positions, the assign dialog needs the nearest free trucks, and a truck entering a stop's radius should mark the stop arrived without anyone clicking. In 0.1 there is no telematics feed, so a simulator plays the trucks.

## Decisions

- **One row per truck**, upserted by `app.record_position()` (migration 0007, revised in 0009 after the Phase 4 review). A report older than the one held is ignored entirely: it neither moves the truck nor runs the arrival check, and the function says so (`applied = false`). A report dated in the future is clamped to `now()`, so a wrong clock cannot arrive tomorrow's pickup today; a heading of 360 or more is normalised. The function runs with the caller's rights under row security, so it can only touch the current company's trucks; the composite foreign key `(truck_id, company_id)` rejects a report for another company's truck even with the caller's own `company_id`.
- **Arrival in the same transaction as the report.** The function finds the truck's active assignment: not ended, on a load that is `assigned` or `in_transit`, the earliest by `lower(period)` when there are several. (The first version required `period @> recorded_at`, which made a late truck unable to arrive once its planned window had closed; late deliveries are the normal case, so the window no longer gates arrival.) It then takes that load's first stop without `arrived_at` and sets it when `ST_DWithin(stop, position, radius)` holds, where the radius is the company's `arrival_radius_miles` (default 1). Stops arrive in sequence order only; an early visit to the delivery does not count. Arrival never changes the load's status: the driver or a dispatcher does that, as the spec says.
- **Events.** The write path emits one `position.updated` per truck (payload: the coordinates, so the map updates without a refetch) and one `stop.arrived` per arrival (addressed to the driver as well, so the driver page can refresh).
- **Nearest free trucks** is one query (`assignmentCandidates` in `apps/web/src/server/loads.ts`): free means no open assignment overlapping the load's window, and the order is `location <-> $pickup`, which the GiST index on `truck_positions.location` serves as a nearest-neighbour scan. The pickup point and the window are read first and passed in as constants; decision 0018 explains why that shape, and not a join, is what lets the index work under row security. The benchmark in `bench/results/geo.json` runs this exact query as the app role on 100,000 trucks with and without that index.
- **The service token.** `POST /api/positions` and `GET /api/simulator/state` accept a bearer token from `SIMULATOR_TOKEN`, compared in constant time, and nothing else; the token grants no session and no access to any page or other route. Position writes run as the `system` role (decision 0010) for the company named in the body; the row security and foreign keys above make a wrong company id harmless.
- **The simulator** (`apps/simulator`) is a plain Node loop: every 3 seconds, per demo company, read the state, move trucks with an active assignment along the great circle toward their next open stop at 55 mph × `SIMULATOR_SPEED_FACTOR` (default 60, one real second per simulated minute), jitter idle trucks within 0.6 miles of home, and post the batch. A truck whose assignment has not started yet stays home until the window opens.
- **Map tiles** come from OpenFreeMap (no key, no billing). Without internet the style fails to load, the component says so, and the markers and stops still render on a blank canvas.

## Rejected

- Arrival computed in the simulator or the app: the rule belongs beside the data; a telematics bridge posting positions later gets it for free.
- A positions history table: out of scope for 0.1 (the outbox keeps 24 hours of `position.updated` events anyway).
- Moving trucks toward tomorrow's pickup early: more lively, but it would fake behaviour the real product does not have.
