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
CREATE POLICY tenant_isolation ON app.outbox
  USING (company_id = app.current_company()) WITH CHECK (company_id = app.current_company());

-- loadline_owner may read companies so app.company_for_org() (SECURITY DEFINER,
-- owned by loadline_owner) can map an organization to its company before any
-- company is set. loadline_owner never logs in from the app at run time.
CREATE POLICY owner_resolves_companies ON app.companies
  FOR SELECT TO loadline_owner USING (true);

-- The app's cleanup job deletes outbox rows older than 24 hours for every
-- company. This is the one cross-company statement loadline_app may run and
-- it can only touch rows that are already too old to be replayed.
CREATE POLICY prune_old_events ON app.outbox
  FOR DELETE TO loadline_app USING (created_at < now() - interval '24 hours');

-- Drivers. Restrictive policies are ANDed with the base policy: when app.role
-- is 'driver', only loads assigned to app.driver_id (and their stops and
-- assignments) are visible, whatever the query says.
CREATE POLICY driver_scope ON app.loads AS RESTRICTIVE
  USING (
    app.current_role_name() IS DISTINCT FROM 'driver'
    OR EXISTS (
      SELECT 1 FROM app.assignments a
      WHERE a.load_id = loads.id AND a.driver_id = app.current_driver()
    )
  );

CREATE POLICY driver_scope ON app.stops AS RESTRICTIVE
  USING (
    app.current_role_name() IS DISTINCT FROM 'driver'
    OR EXISTS (
      SELECT 1 FROM app.assignments a
      WHERE a.load_id = stops.load_id AND a.driver_id = app.current_driver()
    )
  );

CREATE POLICY driver_scope ON app.assignments AS RESTRICTIVE
  USING (
    app.current_role_name() IS DISTINCT FROM 'driver'
    OR driver_id = app.current_driver()
  );

-- Drivers never create or delete dispatch data. They only update the loads
-- (status) and stops (times) they are assigned to, which driver_scope allows.
CREATE POLICY driver_no_insert ON app.loads AS RESTRICTIVE FOR INSERT
  WITH CHECK (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_no_delete ON app.loads AS RESTRICTIVE FOR DELETE
  USING (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_no_insert ON app.stops AS RESTRICTIVE FOR INSERT
  WITH CHECK (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_no_delete ON app.stops AS RESTRICTIVE FOR DELETE
  USING (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_no_insert ON app.assignments AS RESTRICTIVE FOR INSERT
  WITH CHECK (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_no_update ON app.assignments AS RESTRICTIVE FOR UPDATE
  USING (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_no_delete ON app.assignments AS RESTRICTIVE FOR DELETE
  USING (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_read_only ON app.drivers AS RESTRICTIVE FOR INSERT
  WITH CHECK (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_read_only_update ON app.drivers AS RESTRICTIVE FOR UPDATE
  USING (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_read_only_delete ON app.drivers AS RESTRICTIVE FOR DELETE
  USING (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_read_only ON app.trucks AS RESTRICTIVE FOR INSERT
  WITH CHECK (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_read_only_update ON app.trucks AS RESTRICTIVE FOR UPDATE
  USING (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_read_only_delete ON app.trucks AS RESTRICTIVE FOR DELETE
  USING (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_read_only_update ON app.companies AS RESTRICTIVE FOR UPDATE
  USING (app.current_role_name() IS DISTINCT FROM 'driver');
CREATE POLICY driver_read_only_delete ON app.companies AS RESTRICTIVE FOR DELETE
  USING (app.current_role_name() IS DISTINCT FROM 'driver');
