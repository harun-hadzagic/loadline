-- 0006 Assignment helpers, after the Phase 2 review.
--  * app.load_window(load): the one definition of an assignment's period.
--  * app.end_assignment(load, reason): closes the open assignment for staff
--    or for the driver who holds it (drivers may not UPDATE assignments
--    directly, so a driver's "Delivered" needs this definer function).
--  * One membership per user: a person belongs to one company in 0.1.

-- The period an assignment covers: from the first appointment's start (or now,
-- when the window has already opened, so a reassignment does not collide with
-- the closed row of the previous driver) to the last appointment's end.
CREATE FUNCTION app.load_window(p_load_id uuid) RETURNS tstzrange
  LANGUAGE sql STABLE
  AS $$
    SELECT tstzrange(GREATEST(min(lower(s.appointment)), now()), max(upper(s.appointment)), '[)')
      FROM app.stops s WHERE s.load_id = p_load_id
  $$;
GRANT EXECUTE ON FUNCTION app.load_window(uuid) TO loadline_app;

-- Close a load's open assignment. The period is cut to now(), which frees the
-- driver and truck from this moment; a row whose period has not started is
-- deleted instead (empty ranges are not allowed under WITHOUT OVERLAPS). Runs
-- as the owner, but only for staff of the current company or the driver named
-- in app.driver_id who holds the assignment; row security still scopes the
-- company. Returns the number of rows closed or deleted.
CREATE FUNCTION app.end_assignment(p_load_id uuid, p_reason text) RETURNS integer
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
REVOKE EXECUTE ON FUNCTION app.end_assignment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.end_assignment(uuid, text) TO loadline_app;

-- One company per person in 0.1 (see docs/decisions/0011).
CREATE UNIQUE INDEX "member_user_key" ON auth."member" ("userId");
