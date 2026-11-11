-- 0005 Better Auth tables, in the auth schema, reached only by loadline_auth.
-- Generated from the auth config with better-auth's getMigrations()
-- (apps/web/scripts/generate-auth-schema.ts), then schema-qualified and
-- reviewed by hand. Better Auth 1.7.20 with the organization plugin and
-- generateId: "uuid". Column names are camelCase because Better Auth's
-- adapter expects them that way; nothing in app joins to these tables.

CREATE TABLE auth."user" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"           text NOT NULL,
  "email"          text NOT NULL UNIQUE,
  "emailVerified"  boolean NOT NULL,
  "image"          text,
  "createdAt"      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth."session" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "expiresAt"             timestamptz NOT NULL,
  "token"                 text NOT NULL UNIQUE,
  "createdAt"             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             timestamptz NOT NULL,
  "ipAddress"             text,
  "userAgent"             text,
  "userId"                uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "activeOrganizationId"  text
);

CREATE TABLE auth."account" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId"              text NOT NULL,
  "providerId"             text NOT NULL,
  "userId"                 uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "accessToken"            text,
  "refreshToken"           text,
  "idToken"                text,
  "accessTokenExpiresAt"   timestamptz,
  "refreshTokenExpiresAt"  timestamptz,
  "scope"                  text,
  "password"               text,
  "createdAt"              timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              timestamptz NOT NULL
);

CREATE TABLE auth."verification" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "identifier"  text NOT NULL,
  "value"       text NOT NULL,
  "expiresAt"   timestamptz NOT NULL,
  "createdAt"   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth."organization" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"       text NOT NULL,
  "slug"       text NOT NULL UNIQUE,
  "logo"       text,
  "createdAt"  timestamptz NOT NULL,
  "metadata"   text
);

CREATE TABLE auth."member" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId"  uuid NOT NULL REFERENCES auth."organization" ("id") ON DELETE CASCADE,
  "userId"          uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "role"            text NOT NULL,
  "createdAt"       timestamptz NOT NULL
);

CREATE TABLE auth."invitation" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId"  uuid NOT NULL REFERENCES auth."organization" ("id") ON DELETE CASCADE,
  "email"           text NOT NULL,
  "role"            text,
  "status"          text NOT NULL,
  "expiresAt"       timestamptz NOT NULL,
  "createdAt"       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "inviterId"       uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE
);

CREATE INDEX "session_userId_idx" ON auth."session" ("userId");
CREATE INDEX "account_userId_idx" ON auth."account" ("userId");
CREATE INDEX "verification_identifier_idx" ON auth."verification" ("identifier");
CREATE INDEX "member_organizationId_idx" ON auth."member" ("organizationId");
CREATE INDEX "member_userId_idx" ON auth."member" ("userId");
CREATE INDEX "invitation_organizationId_idx" ON auth."invitation" ("organizationId");
CREATE INDEX "invitation_email_idx" ON auth."invitation" ("email");

-- One membership per user per organization: a user has exactly one role in a company.
CREATE UNIQUE INDEX "member_organization_user_key" ON auth."member" ("organizationId", "userId");

-- loadline_auth reads and writes these tables and nothing else. The tables
-- stay owned by loadline_owner, so Better Auth can never alter the schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO loadline_auth;
