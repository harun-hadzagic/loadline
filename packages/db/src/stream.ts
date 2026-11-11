// The outbox reader for the event stream. Runs as loadline_stream, which may
// SELECT app.outbox across companies and nothing else. One dedicated client
// holds the LISTEN; a tiny pool does the reads so a slow read never blocks a
// notification. Nothing here is tenant-scoped: the hub in apps/web filters
// rows by company and audience before anything reaches a browser.
import pg from "pg";
import { requireEnv } from "./env.ts";

/**
 * The visibility-safe cursor: (txid, id). Identity values are handed out at
 * insert time, not commit time, so a reader that takes `id > last` can skip a
 * row whose transaction committed late. Ordering by (txid, id) and only reading
 * rows whose txid is below the snapshot's xmin (every transaction that could
 * still add earlier rows has finished) makes the sequence stable and complete.
 */
export interface Cursor {
  txid: bigint;
  id: bigint;
}

export function encodeCursor(c: Cursor): string {
  return `${c.txid}:${c.id}`;
}

export function decodeCursor(s: string | null | undefined): Cursor | null {
  if (!s) return null;
  const m = /^(\d{1,20}):(\d{1,20})$/.exec(s.trim());
  if (!m) return null;
  try {
    return { txid: BigInt(m[1] as string), id: BigInt(m[2] as string) };
  } catch {
    return null;
  }
}

export function compareCursor(a: Cursor, b: Cursor): number {
  if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export interface OutboxRow {
  id: string;
  txid: string;
  companyId: string;
  type: string;
  entityId: string | null;
  payload: Record<string, unknown>;
  audience: string[] | null;
  createdAt: string;
  cursor: Cursor;
}

/** Rows plus the safe horizon of the snapshot that read them (see readCommitted). */
export interface CommittedBatch {
  rows: OutboxRow[];
  /** Every row at or below this cursor is final: no running transaction can add one before it. */
  horizon: Cursor;
}

const MAX_ID = 9223372036854775807n;

/** The horizon for a snapshot whose xmin is given: (xmin - 1, max id). */
export function horizonFor(xmin: bigint): Cursor {
  return { txid: xmin - 1n, id: MAX_ID };
}

export interface OutboxReaderOptions {
  connectionString?: string;
  channel?: string;
  /** How often the LISTEN connection is checked with a trivial query. */
  healthIntervalMs?: number;
  log?: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
}

const ROW_SELECT = `
  SELECT id::text, txid::text, company_id AS "companyId", type, entity_id AS "entityId",
         payload, audience, to_json(created_at)#>>'{}' AS "createdAt"
    FROM app.outbox`;

export class OutboxReader {
  private readonly url: string;
  private readonly channel: string;
  private readonly healthIntervalMs: number;
  private readonly log: NonNullable<OutboxReaderOptions["log"]>;
  private readonly pool: pg.Pool;
  private listener: pg.Client | null = null;
  private stopped = false;
  private onWake: (() => void) | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;

  constructor(opts: OutboxReaderOptions = {}) {
    this.url = opts.connectionString ?? requireEnv("DATABASE_URL_STREAM");
    this.channel = opts.channel ?? "loadline_events";
    this.healthIntervalMs = opts.healthIntervalMs ?? 10_000;
    this.log = opts.log ?? (() => {});
    this.pool = new pg.Pool({
      connectionString: this.url,
      max: 3,
      application_name: "loadline-stream-read",
    });
  }

  /** Open the LISTEN connection and call onWake on every notification. Reconnects with backoff. */
  async start(onWake: () => void): Promise<void> {
    this.onWake = onWake;
    this.stopped = false;
    await this.connectListener();
    this.healthTimer = setInterval(() => void this.checkHealth(), this.healthIntervalMs);
  }

  private async connectListener(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.url,
      application_name: "loadline-stream-listen",
    });
    client.on("notification", () => this.onWake?.());
    client.on("error", (err) => {
      this.log("warn", "listen connection error", err);
      void this.reconnect();
    });
    client.on("end", () => {
      if (!this.stopped) void this.reconnect();
    });
    await client.connect();
    await client.query(`LISTEN ${this.channel}`);
    this.listener = client;
    this.reconnectAttempt = 0;
    this.log("info", "listening", { channel: this.channel });
    // Anything that happened while we were away: the outbox has it.
    this.onWake?.();
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    const old = this.listener;
    this.listener = null;
    old?.removeAllListeners();
    old?.end().catch(() => {});
    for (;;) {
      if (this.stopped) break;
      const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++);
      this.log("warn", `reconnecting LISTEN in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      try {
        await this.connectListener();
        break;
      } catch (err) {
        this.log("error", "reconnect failed", err);
      }
    }
    this.reconnecting = false;
  }

  private async checkHealth(): Promise<void> {
    if (!this.listener || this.reconnecting) return;
    try {
      await this.listener.query("SELECT 1");
    } catch (err) {
      this.log("warn", "listen connection failed health check", err);
      void this.reconnect();
    }
  }

  /**
   * Rows after the cursor that are safe to hand out: ordered by (txid, id), and
   * only those whose transaction id is below the current snapshot's xmin. The
   * rows of a transaction that is still running (and any row from a later
   * transaction) wait until it finishes, so nothing is ever skipped.
   */
  async readVisible(after: Cursor | null, limit = 500): Promise<OutboxRow[]> {
    const params: unknown[] = [limit];
    let where = "WHERE txid < pg_snapshot_xmin(pg_current_snapshot())";
    if (after) {
      where += " AND (txid, id) > ($2::xid8, $3::bigint)";
      params.push(after.txid.toString(), after.id.toString());
    }
    const r = await this.pool.query<Omit<OutboxRow, "cursor">>(
      `${ROW_SELECT} ${where} ORDER BY txid, id LIMIT $1`,
      params,
    );
    return r.rows.map(withCursor);
  }

  /**
   * Committed rows after the cursor, in (txid, id) order, together with the
   * snapshot's safe horizon. Unlike readVisible, this hands out a committed row
   * even while an older transaction is still running, so one long transaction
   * anywhere in the cluster cannot freeze the board. The caller must therefore
   * de-duplicate by row id (rows above the horizon are read again next time)
   * and must hand clients the horizon, not the row's own cursor, as the id to
   * resume from: a replay from the horizon is complete, a replay from a row
   * above it could skip an older row that commits later.
   */
  async readCommitted(after: Cursor | null, limit = 500): Promise<CommittedBatch> {
    const params: unknown[] = [limit];
    let where = "WHERE pg_visible_in_snapshot(txid, s.snap)";
    if (after) {
      where += " AND (txid, id) > ($2::xid8, $3::bigint)";
      params.push(after.txid.toString(), after.id.toString());
    }
    // One statement, one snapshot: the xmin and the visibility checks agree.
    const r = await this.pool.query<Omit<OutboxRow, "cursor"> & { xmin: string }>(
      `WITH s AS (SELECT pg_current_snapshot() AS snap)
       SELECT id::text, txid::text, company_id AS "companyId", type, entity_id AS "entityId",
              payload, audience, to_json(created_at)#>>'{}' AS "createdAt", pg_snapshot_xmin(s.snap)::text AS xmin
         FROM app.outbox, s ${where} ORDER BY txid, id LIMIT $1`,
      params,
    );
    const xmin = r.rows[0]?.xmin ?? (await this.currentXmin());
    return { rows: r.rows.map(withCursor), horizon: horizonFor(BigInt(xmin)) };
  }

  /** The current safe horizon, for a hub that is starting or has nothing to read. */
  async currentHorizon(): Promise<Cursor> {
    return horizonFor(BigInt(await this.currentXmin()));
  }

  private async currentXmin(): Promise<string> {
    const r = await this.pool.query<{ xmin: string }>(
      "SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin",
    );
    return r.rows[0]?.xmin ?? "0";
  }

  /** The newest visible cursor, for a client that connects without one. */
  async latestCursor(): Promise<Cursor | null> {
    const r = await this.pool.query<{ txid: string; id: string }>(
      "SELECT txid::text, id::text FROM app.outbox WHERE txid < pg_snapshot_xmin(pg_current_snapshot()) ORDER BY txid DESC, id DESC LIMIT 1",
    );
    const row = r.rows[0];
    return row ? { txid: BigInt(row.txid), id: BigInt(row.id) } : null;
  }

  /** The oldest row still kept. A client cursor older than this cannot be replayed from. */
  async oldestCursor(): Promise<Cursor | null> {
    const r = await this.pool.query<{ txid: string; id: string }>(
      "SELECT txid::text, id::text FROM app.outbox ORDER BY txid, id LIMIT 1",
    );
    const row = r.rows[0];
    return row ? { txid: BigInt(row.txid), id: BigInt(row.id) } : null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    const l = this.listener;
    this.listener = null;
    l?.removeAllListeners();
    await l?.end().catch(() => {});
    await this.pool.end();
  }
}

function withCursor(row: Omit<OutboxRow, "cursor">): OutboxRow {
  return { ...row, cursor: { txid: BigInt(row.txid), id: BigInt(row.id) } };
}
