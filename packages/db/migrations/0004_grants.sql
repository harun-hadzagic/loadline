-- 0004 Grants. loadline_owner owns everything (it ran the migrations).
-- loadline_app gets DML through the policies; loadline_stream gets SELECT on
-- the outbox and nothing else; loadline_auth gets nothing in app.

GRANT SELECT ON app.cities, app.load_transitions TO loadline_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.companies, app.drivers, app.trucks, app.loads, app.stops,
  app.assignments, app.truck_positions
TO loadline_app;

-- No privileges on the outbox for the app: it writes through app.emit() and
-- prunes through app.prune_outbox(), both SECURITY DEFINER. Only the stream
-- role reads it.
GRANT SELECT ON app.outbox TO loadline_stream;

GRANT EXECUTE ON FUNCTION app.company_for_org(text) TO loadline_app;
GRANT EXECUTE ON FUNCTION app.emit(text, uuid, jsonb, uuid[]) TO loadline_app;
GRANT EXECUTE ON FUNCTION app.prune_outbox() TO loadline_app;
GRANT EXECUTE ON FUNCTION app.is_staff() TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_company() TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_role_name() TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_driver() TO PUBLIC;
