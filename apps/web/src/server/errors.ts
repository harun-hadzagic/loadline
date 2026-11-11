import {
  ILLEGAL_TRANSITION_SQLSTATE,
  OVERLAP_SQLSTATE,
  pgError,
  UNIQUE_VIOLATION_SQLSTATE,
} from "@loadline/db";

export type ConflictKind = "stale" | "overlap" | "transition" | "duplicate";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ConflictError extends AppError {
  constructor(
    public readonly kind: ConflictKind,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(409, message, { kind, ...details });
    this.name = "ConflictError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You are not allowed to do that.") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

/** Translate a database error into an AppError, or return null if it is not one we know. */
export function fromDbError(err: unknown): AppError | null {
  const e = pgError(err);
  if (!e) return null;
  switch (e.code) {
    case OVERLAP_SQLSTATE:
      return new ConflictError("overlap", overlapMessage(e.constraint), {
        constraint: e.constraint,
      });
    case ILLEGAL_TRANSITION_SQLSTATE:
      return new ConflictError("transition", e.message.replace(/^error:\s*/, ""));
    case UNIQUE_VIOLATION_SQLSTATE:
      return new ConflictError("duplicate", duplicateMessage(e.constraint), {
        constraint: e.constraint,
      });
    case "42501":
      return new ForbiddenError();
    default:
      return null;
  }
}

function overlapMessage(constraint?: string): string {
  switch (constraint) {
    case "assignments_driver_no_overlap":
      return "That driver already has an assignment in this window.";
    case "assignments_truck_no_overlap":
      return "That truck already has an assignment in this window.";
    case "assignments_load_no_overlap":
      return "This load was assigned by someone else just now.";
    default:
      return "That assignment overlaps an existing one.";
  }
}

function duplicateMessage(constraint?: string): string {
  switch (constraint) {
    case "loads_company_id_reference_key":
      return "A load with that reference already exists.";
    case "trucks_company_id_unit_number_key":
      return "A truck with that unit number already exists.";
    default:
      return "That value is already in use.";
  }
}

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; details?: Record<string, unknown> };

/** Run a server action body and turn thrown errors into a serialisable result. */
export async function toActionResult<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const app = err instanceof AppError ? err : fromDbError(err);
    if (app) {
      const out: ActionResult<T> = { ok: false, status: app.status, message: app.message };
      if (app.details) out.details = app.details;
      return out;
    }
    if (err instanceof Error && err.name === "ZodError") {
      return {
        ok: false,
        status: 400,
        message: "Invalid input.",
        details: { issues: JSON.parse(err.message) },
      };
    }
    console.error("[action] unexpected error", err);
    return { ok: false, status: 500, message: "Something went wrong." };
  }
}
