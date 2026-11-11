-- 0002 Triggers and functions: audit columns, the load transition rule,
-- the organization resolver and the outbox writer.

-- Audit columns and an immutable company_id on every tenant table.
CREATE FUNCTION app.touch_row() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'company_id is immutable (table %)', TG_TABLE_NAME
      USING ERRCODE = 'LL002';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(app.current_user_id(), NEW.updated_by);
  RETURN NEW;
END
$$;

CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON app.companies
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON app.drivers
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON app.trucks
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON app.loads
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON app.stops
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON app.assignments
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON app.truck_positions
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- Load status may only move along app.load_transitions, and every update
-- bumps version so optimistic updates (WHERE id = $1 AND version = $2) work.
-- SQLSTATE LL001 is what the app maps to a 409 with the current state.
CREATE FUNCTION app.enforce_load_transition() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT EXISTS (
       SELECT 1 FROM app.load_transitions t
       WHERE t.from_status = OLD.status AND t.to_status = NEW.status
     )
  THEN
    RAISE EXCEPTION 'illegal load transition from % to %', OLD.status, NEW.status
      USING ERRCODE = 'LL001',
            DETAIL = format('load %s', OLD.id),
            HINT = 'Legal transitions are listed in app.load_transitions.';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;

-- Runs after touch_row (triggers fire in name order): "z_" keeps it last.
CREATE TRIGGER z_enforce_load_transition BEFORE UPDATE ON app.loads
  FOR EACH ROW EXECUTE FUNCTION app.enforce_load_transition();

-- Resolve a Better Auth organization to its company. The only place that reads
-- app.companies without a company set: SECURITY DEFINER as loadline_owner, with
-- a fixed search_path, returning nothing but the id.
CREATE FUNCTION app.company_for_org(p_org_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$ SELECT c.id FROM app.companies c WHERE c.org_id = p_org_id $$;

REVOKE EXECUTE ON FUNCTION app.company_for_org(text) FROM PUBLIC;

-- The one way to write an event. Every mutating transaction calls this for
-- each changed entity; the row and the write commit together, and the empty
-- NOTIFY only wakes the stream, which then reads the outbox.
CREATE FUNCTION app.emit(
  p_type       text,
  p_entity_id  uuid,
  p_payload    jsonb DEFAULT '{}'::jsonb,
  p_audience   uuid[] DEFAULT NULL
) RETURNS bigint
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO app.outbox (company_id, type, entity_id, payload, audience)
  VALUES (app.current_company(), p_type, p_entity_id, COALESCE(p_payload, '{}'::jsonb), p_audience)
  RETURNING id INTO v_id;
  PERFORM pg_notify('loadline_events', '');
  RETURN v_id;
END
$$;
