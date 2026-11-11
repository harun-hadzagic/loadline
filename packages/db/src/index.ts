export { dbEnv, loadDotEnv, repoRoot, requireEnv, withCredentials } from "./env.ts";
export * from "./errors.ts";
export { emit, type OutboxEvent } from "./events.ts";
export { pruneOutbox } from "./jobs.ts";
// Deliberately not exported here: appPool, createPool, createDb. The app reaches
// tenant data only through withTenant; tests and benchmarks import them from
// "@loadline/db/testing". authPool is for Better Auth's own schema only.
export {
  authPool,
  closeAppPool,
  type Db,
  firstOrganizationForUser,
  memberRole,
  type Pool,
  type PoolClient,
} from "./pool.ts";
export * as schema from "./schema/index.ts";
export {
  type Equipment,
  formatTstzRange,
  type GeoPoint,
  type LoadStatus,
  parseEwkbPoint,
  parseTstzRange,
  pointSql,
  REFERENCE_TABLES,
  type StopKind,
  TENANT_TABLES,
  type TenantTable,
  type TimeRange,
} from "./schema/index.ts";
export { DEMO, DEMO_COMPANIES, type SeedResult, seed } from "./seed/index.ts";
export {
  type CommittedBatch,
  type Cursor,
  compareCursor,
  decodeCursor,
  encodeCursor,
  horizonFor,
  type OutboxReader as OutboxReaderType,
  OutboxReader,
  type OutboxReaderOptions,
  type OutboxRow,
} from "./stream.ts";
export {
  APP_ROLES,
  type AppRole,
  clearOrgCache,
  companyIdForOrg,
  type TenantContext,
  type Tx,
  tenantContextSchema,
  withTenant,
} from "./with-tenant.ts";
