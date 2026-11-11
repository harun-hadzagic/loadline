import {
  type Cursor,
  compareCursor,
  decodeCursor,
  encodeCursor,
  OutboxReader,
  type OutboxRow,
  pruneOutbox,
  type SnapshotInfo,
} from "@loadline/db";

/**
 * One hub per process. It owns the only LISTEN connection (through
 * OutboxReader, as loadline_stream), keeps the visibility-safe cursor, and
 * fans each outbox row out to the connected clients of its company. Driver
 * clients only receive rows whose audience names them.
 *
 * Wake-ups come from NOTIFY and from a 5-second safety poll; both just run
 * drain(), which reads from the horizon. A lost notification costs latency,
 * never data. Replay for a reconnecting client runs under the same lock as
 * drain(), so a row is never both missed by the replay and skipped by the
 * live path.
 *
 * Two cursors matter. The *horizon* is the spec's visibility-safe cursor:
 * every row at or below it is final because no running transaction can add
 * an earlier one. Committed rows above the horizon are delivered as soon as
 * they are visible (so a long transaction elsewhere delays nothing) and
 * remembered by row id so the next drain does not send them twice. Every SSE
 * frame carries as its id the cursor the browser may safely resume from:
 * min(row cursor, horizon of the read that produced it). A replay from such
 * an id is complete; it may repeat rows the browser already has, which it
 * drops by row id.
 *
 * The rules a drain follows (each one closes a hole a review found): rows
 * and snapshot come from one statement; the horizon advances once per drain,
 * to the horizon of the drain's *first* read; nothing advances when a read
 * fails and the previous snapshot stays valid; the previous snapshot's
 * in-progress list keeps re-reads bounded when an old transaction holds the
 * horizon back; a client that cannot keep up is closed, never skipped.
 */
export interface StreamClient {
  id: number;
  companyId: string;
  role: string;
  driverId: string | null;
  send: (chunk: string) => void;
  close: () => void;
  /** Frames queued but not yet taken by the consumer, when the transport can tell. */
  backlog?: () => number;
}

export interface HubStats {
  clients: number;
  cursor: string | null;
  delivered: number;
  drains: number;
  sentAbove: number;
}

const POLL_MS = 5_000;
const HEARTBEAT_MS = 15_000;
const PRUNE_MS = 10 * 60_000;
const RETRY_MS = 2_000;
const PAGE = 500;
/** A client this many frames behind is closed; it reconnects and replays from its last id. */
const MAX_BACKLOG = 2_000;
const DEBUG = process.env.LOADLINE_STREAM_DEBUG === "1";
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log("[stream:debug]", ...args);
};

class ClientClosed extends Error {}

export class EventHub {
  private readonly reader: OutboxReader;
  private readonly clients = new Set<StreamClient>();
  private readonly closed = new WeakSet<StreamClient>();
  /** The visibility-safe cursor: everything at or below it is final. */
  private horizon: Cursor | null = null;
  /** Row ids already broadcast that sit above the horizon, with their txid. */
  private sentAbove = new Map<string, bigint>();
  /** Snapshot of the last complete drain; lets the next read skip rows it already saw. */
  private lastSnapshot: SnapshotInfo | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private drainQueued = false;
  private draining = false;
  private timers: NodeJS.Timeout[] = [];
  private started: Promise<void> | null = null;
  private delivered = 0;
  private drains = 0;

  constructor(reader?: OutboxReader) {
    this.reader =
      reader ??
      new OutboxReader({
        log: (level, message, extra) => {
          if (level !== "info") console.warn(`[stream] ${message}`, extra ?? "");
        },
      });
  }

  /** Idempotent start; a failed start is not cached, the next call tries again. */
  start(): Promise<void> {
    if (!this.started) {
      this.started = this.doStart().catch((err) => {
        this.started = null;
        throw err;
      });
    }
    return this.started;
  }

  private async doStart(): Promise<void> {
    this.horizon = await this.reader.currentHorizon();
    await this.reader.start(() => this.schedule());
    this.timers.push(setInterval(() => this.schedule(), POLL_MS));
    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(
      setInterval(() => {
        pruneOutbox().catch((err) => console.warn("[stream] prune failed", err));
      }, PRUNE_MS),
    );
    for (const t of this.timers) t.unref?.();
  }

  stats(companyId?: string): HubStats {
    return {
      clients: companyId
        ? [...this.clients].filter((c) => c.companyId === companyId).length
        : this.clients.size,
      cursor: this.horizon ? encodeCursor(this.horizon) : null,
      delivered: this.delivered,
      drains: this.drains,
      sentAbove: this.sentAbove.size,
    };
  }

  /** Run fn with the hub lock held (drain and subscribe are serialised). */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private schedule(): void {
    if (this.draining) {
      this.drainQueued = true;
      return;
    }
    this.draining = true;
    void this.withLock(() => this.drain())
      .catch((err) => console.warn("[stream] drain failed", err))
      .finally(() => {
        this.draining = false;
        if (this.drainQueued) {
          this.drainQueued = false;
          this.schedule();
        }
      });
  }

  /** Was this row already visible (hence already handled) at the last complete drain? */
  private seenByLastDrain(row: OutboxRow): boolean {
    const s = this.lastSnapshot;
    if (!s) return false;
    return row.cursor.txid < s.xmax && !s.xip.includes(row.cursor.txid);
  }

  private async drain(): Promise<void> {
    this.drains++;
    const skip = this.lastSnapshot;
    let after = this.horizon;
    let first: Awaited<ReturnType<OutboxReader["readCommitted"]>> | null = null;
    // A failed read advances nothing and keeps lastSnapshot: it is still a
    // true statement about what was visible then, so the next drain re-reads
    // exactly the rows that could be new.
    for (;;) {
      const batch = await this.reader.readCommitted(after, PAGE, skip);
      first ??= batch;
      debug("drain", {
        after: after ? encodeCursor(after) : null,
        rows: batch.rows.length,
        horizon: encodeCursor(batch.horizon),
      });
      for (const row of batch.rows) {
        if (this.sentAbove.has(row.id)) continue;
        this.sentAbove.set(row.id, row.cursor.txid);
        // The resume id is bounded by the *first* read's horizon: rows on
        // later pages may sort before a row an older transaction commits
        // between pages, and that row is above the first horizon too.
        this.broadcast(row, minCursor(row.cursor, first.horizon));
      }
      if (batch.rows.length < PAGE) break;
      after = batch.rows[batch.rows.length - 1]?.cursor ?? after;
    }
    if (first) {
      this.advanceHorizon(first.horizon);
      this.lastSnapshot = first.snapshot;
      // Rows the next read will never return again cannot be sent twice; forget them.
      for (const [id, txid] of this.sentAbove) {
        if (txid < first.snapshot.xmax && !first.snapshot.xip.includes(txid))
          this.sentAbove.delete(id);
      }
    }
  }

  private advanceHorizon(h: Cursor): void {
    if (this.horizon && compareCursor(h, this.horizon) <= 0) return;
    this.horizon = h;
    for (const [id, txid] of this.sentAbove) if (txid <= h.txid) this.sentAbove.delete(id);
  }

  private matches(client: StreamClient, row: OutboxRow): boolean {
    if (row.companyId !== client.companyId) return false;
    if (client.role === "driver")
      return !!client.driverId && !!row.audience?.includes(client.driverId);
    return true;
  }

  /** Live fan-out: a client that gets dropped never stops the others from receiving the row. */
  private broadcast(row: OutboxRow, resumeFrom: Cursor): void {
    const chunk = formatEvent(row, resumeFrom);
    for (const client of [...this.clients]) {
      if (!this.matches(client, row)) continue;
      try {
        this.deliver(client, chunk);
      } catch {
        // dropped; it reconnects and replays from its last id
      }
    }
  }

  /**
   * Send one frame. A client that is too far behind, or whose transport
   * throws, is closed and dropped; it reconnects and replays from its last
   * id, so nothing is skipped. Throws ClientClosed so a replay in progress
   * for that client stops instead of silently losing frames.
   */
  private deliver(client: StreamClient, chunk: string): void {
    if (this.closed.has(client)) throw new ClientClosed();
    if ((client.backlog?.() ?? 0) > MAX_BACKLOG) {
      this.drop(client);
      throw new ClientClosed();
    }
    try {
      client.send(chunk);
      this.delivered++;
    } catch {
      this.drop(client);
      throw new ClientClosed();
    }
  }

  private drop(client: StreamClient): void {
    this.closed.add(client);
    this.clients.delete(client);
    try {
      client.close();
    } catch {
      // already closed
    }
  }

  private heartbeat(): void {
    for (const client of [...this.clients]) {
      try {
        this.deliver(client, ": ping\n\n");
      } catch {
        // dropped
      }
    }
  }

  /**
   * Attach a client. With a Last-Event-ID, replay what it missed first (or
   * tell it to resync when its cursor is at or below the prune watermark),
   * then switch it to live events, all under the lock so nothing falls between.
   * Throws when the hub cannot start; the route closes the response then.
   * A client that cannot keep up during the replay is closed and not added.
   */
  async subscribe(client: StreamClient, lastEventId: string | null): Promise<void> {
    await this.start();
    try {
      await this.withLock(async () => {
        const from = lastEventId ? decodeCursor(lastEventId) : null;
        if (lastEventId && !from) {
          this.deliver(client, hello(null));
          this.deliver(client, resync("bad-cursor"));
        } else if (from) {
          // hello carries the client's own cursor: until the replay is complete,
          // that is the only id it may safely resume from.
          this.deliver(client, hello(from));
          let after: Cursor | null = from;
          let replayHorizon: Cursor | null = null;
          for (;;) {
            const batch = await this.reader.readCommitted(after, PAGE);
            replayHorizon ??= batch.horizon;
            for (const row of batch.rows) {
              const resumeFrom = minCursor(row.cursor, replayHorizon);
              if (this.matches(client, row)) this.deliver(client, formatEvent(row, resumeFrom));
              // A row the live path has not sent yet (above the horizon, not
              // handled by the last drain) goes to the other clients now too.
              if (
                !this.sentAbove.has(row.id) &&
                this.horizon &&
                compareCursor(row.cursor, this.horizon) > 0 &&
                !this.seenByLastDrain(row)
              ) {
                this.sentAbove.set(row.id, row.cursor.txid);
                this.broadcastExceptSafely(row, resumeFrom, client);
              }
            }
            if (batch.rows.length < PAGE) break;
            after = batch.rows[batch.rows.length - 1]?.cursor ?? after;
          }
          // Read after the replay: a prune that ran meanwhile shows up here.
          const watermark = await this.reader.pruneWatermark();
          if (watermark && compareCursor(from, watermark) <= 0)
            this.deliver(client, resync("pruned"));
        } else {
          this.deliver(client, hello(this.horizon));
        }
        this.clients.add(client);
      });
    } catch (err) {
      if (err instanceof ClientClosed) return; // closed on purpose; the browser reconnects and replays
      throw err;
    }
  }

  private broadcastExceptSafely(row: OutboxRow, resumeFrom: Cursor, except: StreamClient): void {
    const chunk = formatEvent(row, resumeFrom);
    for (const client of [...this.clients]) {
      if (client === except || !this.matches(client, row)) continue;
      try {
        this.deliver(client, chunk);
      } catch {
        // that client was dropped; the one being subscribed is unaffected
      }
    }
  }

  unsubscribe(client: StreamClient): void {
    if (this.clients.delete(client) || !this.closed.has(client)) this.drop(client);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const c of [...this.clients]) this.drop(c);
    await this.reader.stop();
  }
}

function minCursor(a: Cursor, b: Cursor): Cursor {
  return compareCursor(a, b) <= 0 ? a : b;
}

/**
 * One SSE frame. `id` is the cursor the browser may resume from after this
 * frame: the row's own cursor when the row is final, the read's horizon
 * otherwise. The row id in `data` is the de-duplication key.
 */
export function formatEvent(row: OutboxRow, resumeFrom: Cursor): string {
  const data = {
    id: row.id,
    cursor: encodeCursor(row.cursor),
    type: row.type,
    entityId: row.entityId,
    payload: row.payload,
    createdAt: row.createdAt,
  };
  return `id: ${encodeCursor(resumeFrom)}\nevent: ${row.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function hello(cursor: Cursor | null): string {
  const id = cursor ? `id: ${encodeCursor(cursor)}\n` : "";
  return `retry: ${RETRY_MS}\n${id}event: hello\ndata: ${JSON.stringify({ cursor: cursor ? encodeCursor(cursor) : null })}\n\n`;
}

function resync(reason: string): string {
  return `event: resync\ndata: ${JSON.stringify({ reason })}\n\n`;
}

type Globals = typeof globalThis & { __loadlineHub?: EventHub; __loadlineClientSeq?: number };

/** The process-wide hub, guarded on globalThis so dev reloads do not multiply LISTEN connections. */
export function getHub(): EventHub {
  const g = globalThis as Globals;
  if (!g.__loadlineHub) g.__loadlineHub = new EventHub();
  return g.__loadlineHub;
}

export function nextClientId(): number {
  const g = globalThis as Globals;
  g.__loadlineClientSeq = (g.__loadlineClientSeq ?? 0) + 1;
  return g.__loadlineClientSeq;
}
