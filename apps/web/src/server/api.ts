import { z } from "zod";
import { AppError, fromDbError } from "./errors";

/** Shared JSON error shape for route handlers. */
export function jsonError(err: unknown): Response {
  const app = err instanceof AppError ? err : fromDbError(err);
  if (app) {
    return Response.json(
      { error: app.message, details: app.details ?? null },
      { status: app.status },
    );
  }
  if (err instanceof z.ZodError) {
    return Response.json(
      { error: "Invalid input.", details: { issues: err.issues } },
      { status: 400 },
    );
  }
  console.error("[api] unexpected error", err);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError(400, "Body must be JSON.");
  }
}
