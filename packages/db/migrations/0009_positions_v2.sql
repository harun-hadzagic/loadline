-- 0009 Position reports and arrival, after the Phase 4 review.
--  * A report older than the one stored is ignored entirely: no arrival check,
--    and the caller learns it was ignored so it emits no event.
--  * A report dated in the future is clamped to now(), so a bad clock cannot
--    freeze a truck or mark tomorrow's pickup arrived.
--  * The active assignment is the truck's earliest open assignment on a load
--    that is assigned or in transit, not "the one whose planned window
--    contains the report": a late delivery still arrives, and back-to-back
--    loads hand over when the first is delivered, not when its window ends.
--  * app.load_window never produces an empty or inverted range when every
--    appointment is already in the past.

CREATE OR REPLACE FUNCTION app.load_window(p_load_id uuid) RETURNS tstzrange
  LANGUAGE sql STABLE
  AS $$
    SELECT tstzrange(
             GREATEST(min(lower(s.appointment)), now()),
             GREATEST(max(upper(s.appointment)), GREATEST(min(lower(s.appointment)), now()) + interval '1 hour'),
             '[)')
      FROM app.stops s WHERE s.load_id = p_load_id
  $$;

DROP FUNCTION app.record_position(uuid, double precision, double precision, real, real, timestamptz);

CREATE FUNCTION app.record_position(
  p_truck_id     uuid,
  p_lng          double precision,
  p_lat          double precision,
  p_heading      real,
  p_speed_mph    real,
  p_recorded_at  timestamptz DEFAULT now()
) RETURNS TABLE (applied boolean, arrived_stop_id uuid, arrived_load_id uuid, arrived_seq integer)
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_company  uuid := app.current_company();
  v_at       timestamptz := LEAST(p_recorded_at, now());
  v_point    geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  v_radius_m double precision;
  v_rows     integer;
BEGIN
  INSERT INTO app.truck_positions (truck_id, company_id, location, heading, speed_mph, recorded_at)
  VALUES (p_truck_id, v_company, v_point, CASE WHEN p_heading >= 360 THEN p_heading - 360 ELSE p_heading END, p_speed_mph, v_at)
  ON CONFLICT (truck_id) DO UPDATE
     SET location = EXCLUDED.location,
         heading = EXCLUDED.heading,
         speed_mph = EXCLUDED.speed_mph,
         recorded_at = EXCLUDED.recorded_at
   WHERE app.truck_positions.recorded_at <= EXCLUDED.recorded_at;  -- ignore stale reports
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;

  SELECT c.arrival_radius_miles * 1609.344 INTO v_radius_m FROM app.companies c WHERE c.id = v_company;

  RETURN QUERY
  WITH active AS (
    SELECT a.load_id
      FROM app.assignments a
      JOIN app.loads l ON l.id = a.load_id
     WHERE a.truck_id = p_truck_id AND a.ended_reason IS NULL
       AND l.status IN ('assigned', 'in_transit')
     ORDER BY lower(a.period) LIMIT 1
  ),
  next_stop AS (
    SELECT s.id, s.load_id, s.seq
      FROM app.stops s JOIN active ON active.load_id = s.load_id
     WHERE s.arrived_at IS NULL
     ORDER BY s.seq LIMIT 1
  ),
  arrived AS (
    UPDATE app.stops s
       SET arrived_at = v_at
      FROM next_stop
     WHERE s.id = next_stop.id
       AND ST_DWithin(s.location, v_point, COALESCE(v_radius_m, 1609.344))
    RETURNING s.id, s.load_id, s.seq
  )
  SELECT true, arrived.id, arrived.load_id, arrived.seq FROM arrived
  UNION ALL
  SELECT true, NULL::uuid, NULL::uuid, NULL::integer WHERE NOT EXISTS (SELECT 1 FROM arrived);
END
$$;
REVOKE EXECUTE ON FUNCTION app.record_position(uuid, double precision, double precision, real, real, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_position(uuid, double precision, double precision, real, real, timestamptz) TO loadline_app;
