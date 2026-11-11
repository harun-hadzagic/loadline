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

/** What one read saw: the rows, and the snapshot they were read under. */
export interface SnapshotInfo {
  /** Oldest transaction still running when the read happened. */
  xmin: bigint;
  /** First transaction id not yet assigned at that moment. */
  xmax: bigint;
  /** Transactions in progress at that moment (xmin <= x < xmax). */
  xip: bigint[];
}

export interface CommittedBatch {
  rows: OutboxRow[];
  /** Every row at or below this cursor is final: no running transaction can add one before it. */
  horizon: Cursor;
  snapshot: SnapshotInfo;
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
      // A half-open socket must not hang a drain while it holds the hub lock.
      query_timeout: 15_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
    });
  }

  /** Open the LISTEN connection and call onWake on every notification. Reconnects with backoff. */
  async start(onWake: () => void): Promise<void> {
    this.onWake = onWake;
    this.stopped = false;
    try {
      await this.connectListener();
    } catch (err) {
      // Reads still work through the pool and the poll; keep trying to LISTEN in the background.
      this.log("warn", "initial LISTEN failed; retrying in the background", err);
      void this.reconnect();
    }
    this.healthTimer = setInterval(() => void this.checkHealth(), this.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  private async connectListener(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.url,
      application_name: "loadline-stream-listen",
      query_timeout: 15_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
    });
    client.on("notification", () => this.onWake?.());
    client.on("error", (err) => {
      this.log("warn", "listen connection error", err);
      void this.reconnect();
    });
    client.on("end", () => {
      if (!this.stopped) void this.reconnect();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${this.channel}`);
    } catch (err) {
      // Never keep a half-connected client: its later "end" would tear down a healthy listener.
      client.removeAllListeners();
      client.end().catch(() => {});
      throw err;
    }
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
  async readCommitted(
    after: Cursor | null,
    limit = 500,
    skip: SnapshotInfo | null = null,
  ): Promise<CommittedBatch> {
    // One statement, one snapshot: the rows, the xmin and the in-progress list
    // all come from the same instant, even when there are no rows. (A second
    // statement would have a newer snapshot, and a transaction committing in
    // between would fall below the horizon without ever having been read.)
    const params: unknown[] = [limit];
    const conds = ["pg_visible_in_snapshot(o.txid, s.snap)"];
    if (after) {
      conds.push(`(o.txid, o.id) > ($${params.length + 1}::xid8, $${params.length + 2}::bigint)`);
      params.push(after.txid.toString(), after.id.toString());
    }
    if (skip) {
      // Rows visible at the previous read were already handled; only rows from
      // transactions that were in progress then, or newer ones, can be new.
      conds.push(
        `(o.txid >= $${params.length + 1}::xid8 OR o.txid = ANY($${params.length + 2}::xid8[]))`,
      );
      params.push(skip.xmax.toString(), `{${skip.xip.map(String).join(",")}}`);
    }
    type Raw = Partial<Omit<OutboxRow, "cursor">> & {
      xmin: string;
      xmax: string;
      xip: string[] | null;
    };
    const r = await this.pool.query<Raw>(
      `WITH s AS (SELECT pg_current_snapshot() AS snap)
       SELECT pg_snapshot_xmin(s.snap)::text AS xmin, pg_snapshot_xmax(s.snap)::text AS xmax,
              (SELECT array_agg(x::text) FROM pg_snapshot_xip(s.snap) x) AS xip,
              r.id, r.txid, r."companyId", r.type, r."entityId", r.payload, r.audience, r."createdAt"
         FROM s
         LEFT JOIN LATERAL (
           SELECT o.id::text, o.txid::text, o.company_id AS "companyId", o.type, o.entity_id AS "entityId",
                  o.payload, o.audience, to_json(o.created_at)#>>'{}' AS "createdAt"
             FROM app.outbox o
            WHERE ${conds.join(" AND ")}
            ORDER BY o.txid, o.id LIMIT $1
         ) r ON true`,
      params,
    );
    const first = r.rows[0];
    if (!first) throw new Error("snapshot query returned no row");
    const snapshot: SnapshotInfo = {
      xmin: BigInt(first.xmin),
      xmax: BigInt(first.xmax),
      xip: (first.xip ?? []).map((x) => BigInt(x)),
    };
    const rows: OutboxRow[] = [];
    for (const row of r.rows) {
      if (row.id === null || row.id === undefined) continue;
      rows.push(
        withCursor({
          id: row.id,
          txid: row.txid as string,
          companyId: row.companyId as string,
          type: row.type as string,
          entityId: row.entityId ?? null,
          payload: (row.payload ?? {}) as Record<string, unknown>,
          audience: row.audience ?? null,
          createdAt: row.createdAt as string,
        }),
      );
    }
    return { rows, horizon: horizonFor(snapshot.xmin), snapshot };
  }

  /**
   * The highest cursor ever pruned (app.outbox_watermark). A client cursor at or
   * below it may have missed pruned rows and must resync. Null until the first prune.
   */
  async pruneWatermark(): Promise<Cursor | null> {
    const r = await this.pool.query<{ txid: string; id: string }>(
      "SELECT txid::text, outbox_id::text AS id FROM app.outbox_watermark WHERE singleton AND txid IS NOT NULL",
    );
    const row = r.rows[0];
    return row ? { txid: BigInt(row.txid), id: BigInt(row.id) } : null;
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
