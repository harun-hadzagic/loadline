-- 0010 · What a driver may write, enforced in the database.
--
-- The Phase 6 review showed that the restrictive driver_scope policies in 0003
-- limit WHICH rows a driver can update but not WHAT: with the table-wide
-- UPDATE grant a driver could rewrite a load's rate or a stop's appointment,
-- or cancel an assigned load, and only the application stood in the way.
-- "Rules belong in the database": this trigger closes it. Drivers may change
-- a load's status forward to in_transit or delivered, and a stop's arrival and
-- departure times. Nothing else. Staff and the system role are unaffected.
--
-- It also narrows app.end_assignment: a driver may only end their own
-- assignment as 'delivered'; 'unassigned' and 'cancelled' are staff actions.
-- And app.record_position now returns the timestamp it stored, so the event
-- the app emits carries the clamped time rather than the client's claim.

CREATE FUNCTION app.limit_driver_writes() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_audit   text[] := ARRAY['updated_at', 'updated_by', 'version'];
  v_allowed text[];
  v_changed text[];
BEGIN
  IF app.is_staff() THEN
    RETURN NEW;
  END IF;
  v_allowed := CASE TG_TABLE_NAME
    WHEN 'loads' THEN ARRAY['status']
    WHEN 'stops' THEN ARRAY['arrived_at', 'departed_at']
    ELSE ARRAY[]::text[]
  END;
  SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) n
   WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
     AND NOT (n.key = ANY (v_audit || v_allowed));
  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'drivers may not change % on %', array_to_string(v_changed, ', '), TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  -- Through jsonb, because NEW.status does not exist when the row is a stop
  -- and PL/pgSQL resolves the field even in a branch it does not take.
  IF TG_TABLE_NAME = 'loads'
     AND (to_jsonb(NEW) ->> 'status') IS DISTINCT FROM (to_jsonb(OLD) ->> 'status')
     AND (to_jsonb(NEW) ->> 'status') NOT IN ('in_transit', 'delivered') THEN
    RAISE EXCEPTION 'drivers may only move a load to in_transit or delivered, not %', to_jsonb(NEW) ->> 'status'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- "a_" so it runs before touch_row and the transition trigger (name order).
CREATE TRIGGER a_limit_driver_writes BEFORE UPDATE ON app.loads
  FOR EACH ROW EXECUTE FUNCTION app.limit_driver_writes();
CREATE TRIGGER a_limit_driver_writes BEFORE UPDATE ON app.stops
  FOR EACH ROW EXECUTE FUNCTION app.limit_driver_writes();

CREATE OR REPLACE FUNCTION app.end_assignment(p_load_id uuid, p_reason text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
DECLARE
  v_deleted integer;
  v_closed integer;
BEGIN
  IF p_reason NOT IN ('unassigned', 'cancelled', 'delivered') THEN
    RAISE EXCEPTION 'unknown ended_reason %', p_reason USING ERRCODE = '22023';
  END IF;
  IF NOT app.is_staff() THEN
    IF p_reason <> 'delivered' THEN
      RAISE EXCEPTION 'drivers may only end an assignment as delivered' USING ERRCODE = '42501';
    END IF;
    IF app.current_driver() IS NULL OR NOT EXISTS (
      SELECT 1 FROM app.assignments a
      WHERE a.load_id = p_load_id AND a.ended_reason IS NULL AND a.driver_id = app.current_driver()
    ) THEN
      RAISE EXCEPTION 'not allowed to end this assignment' USING ERRCODE = '42501';
    END IF;
  END IF;
  DELETE FROM app.assignments
    WHERE load_id = p_load_id AND ended_reason IS NULL AND lower(period) >= now();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE app.assignments
     SET ended_reason = p_reason,
         period = tstzrange(lower(period), LEAST(upper(period), now()), '[)')
   WHERE load_id = p_load_id AND ended_reason IS NULL;
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_deleted + v_closed;
END
$$;

DROP FUNCTION app.record_position(uuid, double precision, double precision, real, real, timestamptz);

CREATE FUNCTION app.record_position(
  p_truck_id     uuid,
  p_lng          double precision,
  p_lat          double precision,
  p_heading      real,
  p_speed_mph    real,
  p_recorded_at  timestamptz DEFAULT now()
) RETURNS TABLE (applied boolean, recorded_at timestamptz, arrived_stop_id uuid, arrived_load_id uuid, arrived_seq integer)
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
    RETURN QUERY SELECT false, NULL::timestamptz, NULL::uuid, NULL::uuid, NULL::integer;
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
  SELECT true, v_at, arrived.id, arrived.load_id, arrived.seq FROM arrived
  UNION ALL
  SELECT true, v_at, NULL::uuid, NULL::uuid, NULL::integer WHERE NOT EXISTS (SELECT 1 FROM arrived);
END
$$;
REVOKE EXECUTE ON FUNCTION app.record_position(uuid, double precision, double precision, real, real, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_position(uuid, double precision, double precision, real, real, timestamptz) TO loadline_app;
