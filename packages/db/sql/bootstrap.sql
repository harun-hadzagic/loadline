-- Bootstrap: run once per database cluster as the PostgreSQL superuser.
-- Creates the four Loadline roles (passwords are set by src/bootstrap.ts from
-- the environment, never written here), the extensions and the schemas.
-- Everything after this file runs as loadline_owner through migrations/.
--
-- Role           Can                                            Cannot
-- loadline_owner own every table, run migrations                 log in from the app at run time
-- loadline_app   DML on app tables through row-level security    own tables, bypass RLS, read auth
-- loadline_auth  read and write the auth schema for Better Auth  touch app tables
-- loadline_stream SELECT on app.outbox only, across companies    read or write any other table

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loadline_owner') THEN
    CREATE ROLE loadline_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loadline_app') THEN
    CREATE ROLE loadline_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loadline_auth') THEN
    CREATE ROLE loadline_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loadline_stream') THEN
    -- BYPASSRLS so it can read every company's outbox rows and fan them out.
    -- Its grants are limited to SELECT on app.outbox; see docs/decisions.
    CREATE ROLE loadline_stream LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- Extensions live in public. postgis for geography, btree_gist so the
-- temporal constraints can combine a uuid with a tstzrange.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION loadline_owner;
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION loadline_owner;
CREATE SCHEMA IF NOT EXISTS meta AUTHORIZATION loadline_owner;

-- Nobody creates objects in public at run time; everyone may call the
-- PostGIS functions that live there.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;

-- Schema access. Table grants come with the migrations that create the tables.
GRANT USAGE ON SCHEMA app TO loadline_app, loadline_stream;
GRANT USAGE ON SCHEMA auth TO loadline_auth;
REVOKE ALL ON SCHEMA app FROM loadline_auth;
REVOKE ALL ON SCHEMA auth FROM loadline_app, loadline_stream;
