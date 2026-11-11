import { sql } from "drizzle-orm";
import type { Tx } from "./with-tenant.ts";

export interface OutboxEvent {
  /** Dotted name, e.g. "load.updated". */
  type: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
  /**
   * null: every non-driver client of the company. Driver clients only ever
   * receive events whose audience names their driver id.
   */
  audience?: string[] | null;
}

/**
 * The shared write path's one job: record the event in the outbox and wake the
 * stream, inside the caller's transaction, through app.emit(). Every mutation
 * calls this once per changed entity; a test counts them.
 */
export async function emit(tx: Tx, event: OutboxEvent): Promise<string> {
  // Arrays go over as a PostgreSQL array literal; the driver would otherwise
  // hand drizzle's parameter to pg as a bare string.
  const audience = event.audience?.length ? `{${event.audience.join(",")}}` : null;
  const r = await tx.execute<{ id: string }>(sql`
    SELECT app.emit(
      ${event.type},
      ${event.entityId ?? null}::uuid,
      ${JSON.stringify(event.payload ?? {})}::jsonb,
      ${audience}::uuid[]
    ) AS id
  `);
  const id = r.rows[0]?.id;
  if (!id) throw new Error("app.emit returned no id");
  return id;
}
