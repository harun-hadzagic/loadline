-- 0003 Row-level security. Enabled and FORCED on every tenant table, so even
-- the owner is subject to the policies. The base policy is the same everywhere:
-- rows of the current company only, for reading and for writing.

ALTER TABLE app.companies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.companies        FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.drivers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.drivers          FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.trucks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.trucks           FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.loads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.loads            FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.stops            ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stops            FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.assignments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.assignments      FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.truck_positions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.truck_positions  FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.outbox           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox           FORCE  ROW LEVEL SECURITY;

-- Base policy: company_id must equal app.current_company(). With no company
-- set the function returns NULL, the comparison is NULL, and nothing matches.
CREATE POLICY tenant_isolation ON app.companies
  USING (company_id = app.current_company()) WITH CHECK (company_id = app.current_company());
CREATE POLICY tenant_isolation ON app.drivers
  USING (company_id = app.current_company()) WITH CHECK (company_id = app.current_company());
CREATE POLICY tenant_isolation ON app.trucks
  USING (company_id = app.current_company()) WITH CHECK (company_id = app.current_company());
CREATE POLICY tenant_isolation ON app.loads
  USING (company_id = app.current_company()) WITH CHECK (company_id = app.current_company());
CREATE POLICY tenant_isolation ON app.stops
  USING (company_id = app.current_company()) WITH CHECK (company_id = app.current_company());
CREATE POLICY tenant_isolation ON app.assignments
  USING (company_id = app.current_company()) WITH CHECK (company_id = app.current_company());
CREATE POLICY tenant_isolation ON app.truck_positions
  USING (company_id = app.current_company()) WITH CHECK (company_id = app.current_company());

-- The outbox is append-only: it only ever gets SELECT and INSERT policies, so
-- no role can UPDATE or DELETE a live event. (loadline_app has no privileges
-- on it at all; it writes through app.emit, which runs as the owner.)
CREATE POLICY tenant_isolation_select ON app.outbox FOR SELECT
  USING (company_id = app.current_company());
CREATE POLICY tenant_isolation_insert ON app.outbox FOR INSERT
  WITH CHECK (company_id = app.current_company());

-- loadline_owner may read companies so app.company_for_org() (SECURITY DEFINER,
-- owned by loadline_owner) can map an organization to its company before any
-- company is set. loadline_owner never logs in from the app at run time.
CREATE POLICY owner_resolves_companies ON app.companies
  FOR SELECT TO loadline_owner USING (true);

-- app.prune_outbox() (SECURITY DEFINER as loadline_owner) deletes events older
-- than 24 hours for every company. A DELETE with a WHERE clause also needs
-- SELECT visibility of the rows, hence the matching SELECT policy. Both are
-- limited to rows already too old to be replayed.
CREATE POLICY owner_prunes_old_events_select ON app.outbox
  FOR SELECT TO loadline_owner USING (created_at < now() - interval '24 hours');
CREATE POLICY owner_prunes_old_events ON app.outbox
  FOR DELETE TO loadline_owner USING (created_at < now() - interval '24 hours');

-- Drivers. Restrictive policies are ANDed with the base policy: when the role
-- is not staff (see app.is_staff()), only loads with an open assignment for
-- app.driver_id, and their stops and assignments, are visible or writable.
-- An assignment that has ended takes the load away from the driver at once.
CREATE POLICY driver_scope ON app.loads AS RESTRICTIVE
  USING (
    app.is_staff()
    OR EXISTS (
      SELECT 1 FROM app.assignments a
      WHERE a.load_id = loads.id AND a.driver_id = app.current_driver() AND a.ended_reason IS NULL
    )
  );

CREATE POLICY driver_scope ON app.stops AS RESTRICTIVE
  USING (
    app.is_staff()
    OR EXISTS (
      SELECT 1 FROM app.assignments a
      WHERE a.load_id = stops.load_id AND a.driver_id = app.current_driver() AND a.ended_reason IS NULL
    )
  );

CREATE POLICY driver_scope ON app.assignments AS RESTRICTIVE
  USING (app.is_staff() OR (driver_id = app.current_driver() AND ended_reason IS NULL));

-- Drivers see their own driver row only, and may not see other drivers' phones.
CREATE POLICY driver_scope ON app.drivers AS RESTRICTIVE
  USING (app.is_staff() OR id = app.current_driver());

-- Drivers never create or delete dispatch data, never touch assignments,
-- drivers, trucks, positions or the company. They only update the loads
-- (status) and stops (times) they are currently assigned to.
CREATE POLICY staff_only_insert ON app.loads AS RESTRICTIVE FOR INSERT WITH CHECK (app.is_staff());
CREATE POLICY staff_only_delete ON app.loads AS RESTRICTIVE FOR DELETE USING (app.is_staff());
CREATE POLICY staff_only_insert ON app.stops AS RESTRICTIVE FOR INSERT WITH CHECK (app.is_staff());
CREATE POLICY staff_only_delete ON app.stops AS RESTRICTIVE FOR DELETE USING (app.is_staff());
CREATE POLICY staff_only_insert ON app.assignments AS RESTRICTIVE FOR INSERT WITH CHECK (app.is_staff());
CREATE POLICY staff_only_update ON app.assignments AS RESTRICTIVE FOR UPDATE USING (app.is_staff());
CREATE POLICY staff_only_delete ON app.assignments AS RESTRICTIVE FOR DELETE USING (app.is_staff());
CREATE POLICY staff_only_insert ON app.drivers AS RESTRICTIVE FOR INSERT WITH CHECK (app.is_staff());
CREATE POLICY staff_only_update ON app.drivers AS RESTRICTIVE FOR UPDATE USING (app.is_staff());
CREATE POLICY staff_only_delete ON app.drivers AS RESTRICTIVE FOR DELETE USING (app.is_staff());
CREATE POLICY staff_only_insert ON app.trucks AS RESTRICTIVE FOR INSERT WITH CHECK (app.is_staff());
CREATE POLICY staff_only_update ON app.trucks AS RESTRICTIVE FOR UPDATE USING (app.is_staff());
CREATE POLICY staff_only_delete ON app.trucks AS RESTRICTIVE FOR DELETE USING (app.is_staff());
CREATE POLICY staff_only_insert ON app.truck_positions AS RESTRICTIVE FOR INSERT WITH CHECK (app.is_staff());
CREATE POLICY staff_only_update ON app.truck_positions AS RESTRICTIVE FOR UPDATE USING (app.is_staff());
CREATE POLICY staff_only_delete ON app.truck_positions AS RESTRICTIVE FOR DELETE USING (app.is_staff());
CREATE POLICY staff_only_update ON app.companies AS RESTRICTIVE FOR UPDATE USING (app.is_staff());
CREATE POLICY staff_only_delete ON app.companies AS RESTRICTIVE FOR DELETE USING (app.is_staff());

-- A load enters the system as open (the seed, as system, may insert any
-- state), and only open or cancelled loads can be deleted, so a DELETE plus
-- INSERT cannot replay a delivered load as a fresh one.
CREATE POLICY loads_start_open ON app.loads AS RESTRICTIVE FOR INSERT
  WITH CHECK (status = 'open' OR app.current_role_name() = 'system');
CREATE POLICY loads_delete_only_idle ON app.loads AS RESTRICTIVE FOR DELETE
  USING (status IN ('open', 'cancelled'));
