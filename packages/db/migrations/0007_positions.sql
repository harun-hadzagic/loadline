-- 0007 Position reports and automatic arrival.
-- app.record_position() upserts the truck's latest position and, in the same
-- transaction, marks the next open stop of the truck's active assignment as
-- arrived when the truck is within the company's arrival radius. It runs with
-- the caller's rights (loadline_app under row security), so it can only touch
-- the current company's rows. Arrival never changes the load's status; the
-- driver or a dispatcher does that.

CREATE FUNCTION app.record_position(
  p_truck_id     uuid,
  p_lng          double precision,
  p_lat          double precision,
  p_heading      real,
  p_speed_mph    real,
  p_recorded_at  timestamptz DEFAULT now()
) RETURNS TABLE (arrived_stop_id uuid, arrived_load_id uuid, arrived_seq integer)
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_company  uuid := app.current_company();
  v_point    geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  v_radius_m double precision;
BEGIN
  INSERT INTO app.truck_positions (truck_id, company_id, location, heading, speed_mph, recorded_at)
  VALUES (p_truck_id, v_company, v_point, p_heading, p_speed_mph, p_recorded_at)
  ON CONFLICT (truck_id) DO UPDATE
     SET location = EXCLUDED.location,
         heading = EXCLUDED.heading,
         speed_mph = EXCLUDED.speed_mph,
         recorded_at = EXCLUDED.recorded_at
   WHERE app.truck_positions.recorded_at <= EXCLUDED.recorded_at;  -- ignore stale reports

  SELECT c.arrival_radius_miles * 1609.344 INTO v_radius_m FROM app.companies c WHERE c.id = v_company;

  -- The next stop without an arrival on the truck's active assignment, if the
  -- truck is now within the radius. ST_DWithin on geography is index-assisted.
  RETURN QUERY
  WITH active AS (
    SELECT a.load_id
      FROM app.assignments a
     WHERE a.truck_id = p_truck_id AND a.ended_reason IS NULL AND a.period @> p_recorded_at
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
       SET arrived_at = p_recorded_at
      FROM next_stop
     WHERE s.id = next_stop.id
       AND ST_DWithin(s.location, v_point, COALESCE(v_radius_m, 1609.344))
    RETURNING s.id, s.load_id, s.seq
  )
  SELECT arrived.id, arrived.load_id, arrived.seq FROM arrived;
END
$$;
REVOKE EXECUTE ON FUNCTION app.record_position(uuid, double precision, double precision, real, real, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_position(uuid, double precision, double precision, real, real, timestamptz) TO loadline_app;
