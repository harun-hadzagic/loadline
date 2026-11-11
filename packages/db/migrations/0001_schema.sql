-- 0001 Schema: types, session functions, reference tables, tenant tables.
-- Hand-written, applied as loadline_owner inside one transaction.
-- Conventions: tenant tables live in app, have company_id uuid not null,
-- uuidv7() keys (built into PostgreSQL 18), created_at / updated_at / updated_by,
-- timestamptz for every time, integer cents for money, integer pounds for weight.

CREATE TYPE app.equipment AS ENUM ('dry_van', 'reefer', 'flatbed');
CREATE TYPE app.load_status AS ENUM ('open', 'assigned', 'in_transit', 'delivered', 'cancelled');
CREATE TYPE app.stop_kind AS ENUM ('pickup', 'delivery');

-- Request context. withTenant() sets these with set_config(name, value, true),
-- so they are transaction-local and a pooled connection never carries them on.
-- With nothing set they return NULL and every policy below sees nothing.
CREATE FUNCTION app.current_company() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.company_id', true), '')::uuid $$;

CREATE FUNCTION app.current_role_name() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.role', true), '') $$;

CREATE FUNCTION app.current_user_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

CREATE FUNCTION app.current_driver() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.driver_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Reference data (not tenant data, readable by all app roles)
-- ---------------------------------------------------------------------------

-- About 1,000 US places from Census Bureau files; see packages/db/data/README.md.
-- The key is the Census GEOID (state FIPS + place FIPS) so the CSV is stable
-- across rebuilds and the seed can name cities deterministically.
CREATE TABLE app.cities (
  id          integer PRIMARY KEY,
  name        text NOT NULL,
  state       char(2) NOT NULL,
  location    geography(Point, 4326) NOT NULL,
  timezone    text NOT NULL,
  population  integer NOT NULL
);
CREATE INDEX cities_location_idx ON app.cities USING gist (location);
CREATE INDEX cities_name_state_idx ON app.cities (lower(name), state);

-- Legal status changes for a load. A trigger on app.loads consults this table,
-- so no code path can skip the rule. Who may make each change is the app's job.
CREATE TABLE app.load_transitions (
  from_status app.load_status NOT NULL,
  to_status   app.load_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO app.load_transitions (from_status, to_status) VALUES
  ('open',       'assigned'),
  ('assigned',   'open'),
  ('assigned',   'in_transit'),
  ('in_transit', 'delivered'),
  ('open',       'cancelled'),
  ('assigned',   'cancelled');

-- ---------------------------------------------------------------------------
-- Tenant tables
-- ---------------------------------------------------------------------------

-- One row per Better Auth organization. company_id is generated from id so the
-- same tenant_isolation policy shape applies here as everywhere else.
CREATE TABLE app.companies (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id            uuid NOT NULL GENERATED ALWAYS AS (id) STORED,
  org_id                text NOT NULL UNIQUE,
  name                  text NOT NULL,
  timezone              text NOT NULL DEFAULT 'America/Chicago',
  arrival_radius_miles  numeric(6, 2) NOT NULL DEFAULT 1.00 CHECK (arrival_radius_miles > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text
);

CREATE TABLE app.drivers (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES app.companies (id),
  user_id       text UNIQUE,            -- Better Auth user id when the driver signs in
  name          text NOT NULL,
  phone         text,
  home_city_id  integer REFERENCES app.cities (id),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  -- Lets child tables reference (id, company_id) so a row can never point at
  -- another company's driver, even though FK checks bypass row security.
  UNIQUE (id, company_id)
);
CREATE INDEX drivers_company_idx ON app.drivers (company_id);

CREATE TABLE app.trucks (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES app.companies (id),
  unit_number   text NOT NULL,
  equipment     app.equipment NOT NULL,
  home_city_id  integer REFERENCES app.cities (id),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  UNIQUE (company_id, unit_number),
  UNIQUE (id, company_id)
);

CREATE TABLE app.loads (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES app.companies (id),
  reference     text NOT NULL,
  broker_name   text,
  commodity     text,
  weight_lbs    integer CHECK (weight_lbs IS NULL OR weight_lbs >= 0),
  rate_cents    integer CHECK (rate_cents IS NULL OR rate_cents >= 0),
  equipment     app.equipment,
  status        app.load_status NOT NULL DEFAULT 'open',
  version       integer NOT NULL DEFAULT 1,   -- bumped by trigger on every update
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  UNIQUE (company_id, reference),
  UNIQUE (id, company_id)
);
CREATE INDEX loads_company_status_idx ON app.loads (company_id, status);

CREATE TABLE app.stops (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES app.companies (id),
  load_id        uuid NOT NULL,
  seq            integer NOT NULL CHECK (seq >= 1),
  kind           app.stop_kind NOT NULL,
  city_id        integer NOT NULL REFERENCES app.cities (id),
  location       geography(Point, 4326) NOT NULL,
  facility_name  text,
  -- Appointment window in absolute time; shown in the stop's local zone.
  appointment    tstzrange NOT NULL CHECK (
                   NOT isempty(appointment)
                   AND lower(appointment) IS NOT NULL
                   AND upper(appointment) IS NOT NULL
                 ),
  arrived_at     timestamptz,
  departed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text,
  FOREIGN KEY (load_id, company_id) REFERENCES app.loads (id, company_id) ON DELETE CASCADE,
  UNIQUE (load_id, seq),
  UNIQUE (id, company_id)
);
CREATE INDEX stops_load_idx ON app.stops (load_id, seq);
CREATE INDEX stops_location_idx ON app.stops USING gist (location);

-- An assignment ties a load to one driver and one truck for a period. The
-- period runs from the start of the first pickup window to the end of the
-- last delivery window. The WITHOUT OVERLAPS constraints below are the
-- no-double-booking rule; they need btree_gist for the uuid columns.
CREATE TABLE app.assignments (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES app.companies (id),
  load_id       uuid NOT NULL,
  driver_id     uuid NOT NULL,
  truck_id      uuid NOT NULL,
  period        tstzrange NOT NULL,
  -- Set when the assignment ends before its planned window closes. The period
  -- is then cut to now(); if now() is before the period starts the row is
  -- deleted instead (empty ranges are not allowed under WITHOUT OVERLAPS).
  ended_reason  text CHECK (ended_reason IN ('unassigned', 'cancelled', 'delivered')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  FOREIGN KEY (load_id, company_id)   REFERENCES app.loads   (id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (driver_id, company_id) REFERENCES app.drivers (id, company_id),
  FOREIGN KEY (truck_id, company_id)  REFERENCES app.trucks  (id, company_id),
  UNIQUE (id, company_id),
  CONSTRAINT assignments_driver_no_overlap UNIQUE (driver_id, period WITHOUT OVERLAPS),
  CONSTRAINT assignments_truck_no_overlap  UNIQUE (truck_id,  period WITHOUT OVERLAPS),
  CONSTRAINT assignments_load_no_overlap   UNIQUE (load_id,   period WITHOUT OVERLAPS)
);
CREATE INDEX assignments_company_open_idx ON app.assignments (company_id) WHERE ended_reason IS NULL;

-- One latest position per truck, upserted on every report.
CREATE TABLE app.truck_positions (
  truck_id     uuid PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES app.companies (id),
  location     geography(Point, 4326) NOT NULL,
  heading      real CHECK (heading IS NULL OR (heading >= 0 AND heading < 360)),
  speed_mph    real CHECK (speed_mph IS NULL OR speed_mph >= 0),
  recorded_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  FOREIGN KEY (truck_id, company_id) REFERENCES app.trucks (id, company_id) ON DELETE CASCADE
);
CREATE INDEX truck_positions_location_idx ON app.truck_positions USING gist (location);
CREATE INDEX truck_positions_company_idx ON app.truck_positions (company_id);

-- Transactional outbox. Append-only: it has no updated_* columns on purpose and
-- loadline_app never gets UPDATE on it. txid is the writing transaction's id,
-- which is what makes the visibility-safe cursor possible (see 0002 and docs).
CREATE TABLE app.outbox (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txid        xid8 NOT NULL DEFAULT pg_current_xact_id(),
  company_id  uuid NOT NULL REFERENCES app.companies (id),
  type        text NOT NULL,
  entity_id   uuid,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience    uuid[],          -- NULL: everyone in the company; else driver ids
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_cursor_idx ON app.outbox (txid, id);
CREATE INDEX outbox_created_at_idx ON app.outbox (created_at);

-- Migration bookkeeping lives outside app so the RLS catalog test stays strict.
-- (The runner creates meta.migrations itself before applying this file.)
