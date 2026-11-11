-- 0002 Triggers and functions: audit columns, the load transition rule,
-- the organization resolver and the outbox writer.

-- "Staff" is every role that is not a driver. An allowlist, so an unset or
-- misspelled role fails closed rather than open.
CREATE FUNCTION app.is_staff() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT app.current_role_name() IN ('owner', 'admin', 'dispatcher', 'system') $$;

-- Audit columns and an immutable company_id on every tenant table.
-- updated_by is always the acting user (NULL for service writes); callers
-- cannot supply it. On companies the generated company_id is not computed
-- yet in a BEFORE trigger, so the check uses id there.
CREATE FUNCTION app.touch_row() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'companies' THEN
      IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'company_id is immutable (table %)', TG_TABLE_NAME USING ERRCODE = 'LL002';
      END IF;
    ELSIF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'company_id is immutable (table %)', TG_TABLE_NAME USING ERRCODE = 'LL002';
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := app.current_user_id();
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

-- A new load always starts at version 1, whatever the INSERT says, so the
-- version is monotonic for the life of the id.
CREATE FUNCTION app.init_load_version() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.version := 1;
  RETURN NEW;
END
$$;
CREATE TRIGGER z_init_load_version BEFORE INSERT ON app.loads
  FOR EACH ROW EXECUTE FUNCTION app.init_load_version();

-- Every load has at least one pickup and one delivery. Checked at commit
-- (deferred constraint trigger), because a load and its stops are inserted in
-- the same transaction. A load whose stops were all deleted fails too, unless
-- the load itself is gone.
CREATE FUNCTION app.check_load_stops() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_load_id uuid;
  v_pickups int;
  v_deliveries int;
BEGIN
  IF TG_TABLE_NAME = 'loads' THEN
    v_load_id := NEW.id;
  ELSE
    v_load_id := COALESCE(NEW.load_id, OLD.load_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.loads l WHERE l.id = v_load_id) THEN
    RETURN NULL;
  END IF;
  SELECT count(*) FILTER (WHERE kind = 'pickup'), count(*) FILTER (WHERE kind = 'delivery')
    INTO v_pickups, v_deliveries
    FROM app.stops s WHERE s.load_id = v_load_id;
  IF v_pickups < 1 OR v_deliveries < 1 THEN
    RAISE EXCEPTION 'load % needs at least one pickup and one delivery stop', v_load_id
      USING ERRCODE = 'LL003';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER check_load_stops AFTER INSERT ON app.loads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_load_stops();
CREATE CONSTRAINT TRIGGER check_load_stops AFTER INSERT OR UPDATE OR DELETE ON app.stops
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_load_stops();

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
-- SECURITY DEFINER: loadline_app has no privileges on app.outbox at all, so
-- id, txid and created_at can never be supplied by a caller and rows can
-- never be deleted by one. The owner is still under FORCE ROW LEVEL SECURITY,
-- so tenant_isolation's WITH CHECK stamps the current company and nothing else.
CREATE FUNCTION app.emit(
  p_type       text,
  p_entity_id  uuid,
  p_payload    jsonb DEFAULT '{}'::jsonb,
  p_audience   uuid[] DEFAULT NULL
) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = app, pg_temp
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
REVOKE EXECUTE ON FUNCTION app.emit(text, uuid, jsonb, uuid[]) FROM PUBLIC;

-- Delete events too old to be replayed, for every company. SECURITY DEFINER
-- as loadline_owner, whose only outbox policies beyond tenant_isolation are
-- the two "older than 24 hours" ones in 0003, so this cannot touch a live row.
CREATE FUNCTION app.prune_outbox() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM app.outbox WHERE created_at < now() - interval '24 hours';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
REVOKE EXECUTE ON FUNCTION app.prune_outbox() FROM PUBLIC;
