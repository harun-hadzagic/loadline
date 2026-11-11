// SQLSTATEs the application maps to HTTP responses. The overlap code is
// asserted by packages/db/test/db/overlap.test.ts against a real PostgreSQL 18,
// not assumed from the docs.

/** WITHOUT OVERLAPS violations raise exclusion_violation. */
export const OVERLAP_SQLSTATE = "23P01";
/** Raised by app.enforce_load_transition() for a status change not in app.load_transitions. */
export const ILLEGAL_TRANSITION_SQLSTATE = "LL001";
/** Raised by app.touch_row() when an UPDATE tries to move a row to another company. */
export const IMMUTABLE_COMPANY_SQLSTATE = "LL002";
/** Row-level security or privilege violation. */
export const INSUFFICIENT_PRIVILEGE_SQLSTATE = "42501";
/** Unique violation (e.g. duplicate load reference). */
export const UNIQUE_VIOLATION_SQLSTATE = "23505";

export interface PgErrorLike {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
}

export function pgError(err: unknown): PgErrorLike | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; cause?: unknown; message?: unknown };
  if (typeof e.code === "string") return e as PgErrorLike;
  if (e.cause) return pgError(e.cause);
  return null;
}

export function isOverlapViolation(err: unknown): boolean {
  return pgError(err)?.code === OVERLAP_SQLSTATE;
}

export function isIllegalTransition(err: unknown): boolean {
  return pgError(err)?.code === ILLEGAL_TRANSITION_SQLSTATE;
}
