import {
  type Cursor,
  compareCursor,
  decodeCursor,
  encodeCursor,
  OutboxReader,
  type OutboxRow,
  pruneOutbox,
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
 * an earlier one. It is what clients get as the SSE id and resume from.
 * Committed rows above the horizon are delivered as soon as they are visible
 * (so a long transaction elsewhere delays nothing) and remembered by row id
 * so the next drain does not send them twice; a client that reconnects may
 * see such a row again and de-duplicates by row id too.
 */
export interface StreamClient {
  id: number;
  companyId: string;
  role: string;
  driverId: string | null;
  send: (chunk: string) => void;
  close: () => void;
}

export interface HubStats {
  clients: number;
  cursor: string | null;
  delivered: number;
  drains: number;
}

const POLL_MS = 5_000;
const DEBUG = process.env.LOADLINE_STREAM_DEBUG === "1";
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log("[stream:debug]", ...args);
};
const HEARTBEAT_MS = 15_000;
const PRUNE_MS = 10 * 60_000;
const RETRY_MS = 2_000;
const PAGE = 500;

export class EventHub {
  private readonly reader: OutboxReader;
  private readonly clients = new Set<StreamClient>();
  /** The visibility-safe cursor: everything at or below it is final. */
  private horizon: Cursor | null = null;
  /** Row ids already broadcast that sit above the horizon, with their txid. */
  private sentAbove = new Map<string, bigint>();
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

  start(): Promise<void> {
    if (!this.started) this.started = this.doStart();
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

  stats(): HubStats {
    return {
      clients: this.clients.size,
      cursor: this.horizon ? encodeCursor(this.horizon) : null,
      delivered: this.delivered,
      drains: this.drains,
    };
  }

  /** Run fn with the hub lock held (drain and subscribe are serialised). */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private schedule(): void {
    debug("schedule", { draining: this.draining, queued: this.drainQueued });
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

  private async drain(): Promise<void> {
    this.drains++;
    let after = this.horizon;
    for (;;) {
      const batch = await this.reader.readCommitted(after, PAGE);
      debug("drain", {
        after: after ? encodeCursor(after) : null,
        rows: batch.rows.map((r) => `${r.id}@${r.txid}`),
        horizon: encodeCursor(batch.horizon),
        clients: this.clients.size,
        sentAbove: [...this.sentAbove.keys()],
      });
      for (const row of batch.rows) {
        if (!this.sentAbove.has(row.id)) {
          this.sentAbove.set(row.id, row.cursor.txid);
          this.broadcast(row, batch.horizon);
        }
      }
      this.advanceHorizon(batch.horizon);
      if (batch.rows.length < PAGE) break;
      after = batch.rows[batch.rows.length - 1]?.cursor ?? after;
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

  private broadcast(row: OutboxRow, horizon: Cursor): void {
    const chunk = formatEvent(row, horizon);
    let n = 0;
    for (const client of this.clients) {
      if (this.matches(client, row)) {
        this.deliver(client, chunk);
        n++;
      }
    }
    debug("broadcast", {
      id: row.id,
      type: row.type,
      company: row.companyId,
      to: n,
      of: this.clients.size,
    });
  }

  /** A row found during a replay that the live path has not sent yet goes to everyone else too. */
  private broadcastExcept(row: OutboxRow, horizon: Cursor, except: StreamClient): void {
    const chunk = formatEvent(row, horizon);
    for (const client of this.clients) {
      if (client !== except && this.matches(client, row)) this.deliver(client, chunk);
    }
  }

  private deliver(client: StreamClient, chunk: string): void {
    try {
      client.send(chunk);
      this.delivered++;
    } catch {
      this.unsubscribe(client);
    }
  }

  private heartbeat(): void {
    for (const client of this.clients) this.deliver(client, ": ping\n\n");
  }

  /**
   * Attach a client. With a Last-Event-ID, replay what it missed first (or
   * tell it to resync when its cursor predates the oldest kept row), then
   * switch it to live events, all under the lock so nothing falls between.
   */
  async subscribe(client: StreamClient, lastEventId: string | null): Promise<void> {
    await this.start();
    await this.withLock(async () => {
      const from = lastEventId ? decodeCursor(lastEventId) : null;
      this.deliver(client, hello(this.horizon));
      if (lastEventId && !from) {
        this.deliver(client, resync("bad-cursor"));
      } else if (from) {
        const oldest = await this.reader.oldestCursor();
        if (oldest && compareCursor(from, oldest) < 0) {
          // Rows between the client's cursor and the oldest kept row may be gone.
          this.deliver(client, resync("pruned"));
        } else {
          // Everything committed after the client's horizon, in order. Rows the
          // live path already broadcast (above the hub horizon, in sentAbove)
          // are included on purpose: the client de-duplicates by row id, and
          // skipping them here could miss one delivered between its last
          // receipt and the drop.
          let after: Cursor | null = from;
          for (;;) {
            const batch = await this.reader.readCommitted(after, PAGE);
            for (const row of batch.rows) {
              if (this.matches(client, row)) this.deliver(client, formatEvent(row, batch.horizon));
              // Keep the live path from sending it a second time right away.
              if (
                !this.sentAbove.has(row.id) &&
                this.horizon &&
                compareCursor(row.cursor, this.horizon) > 0
              ) {
                this.sentAbove.set(row.id, row.cursor.txid);
                this.broadcastExcept(row, batch.horizon, client);
              }
            }
            if (batch.rows.length < PAGE) break;
            after = batch.rows[batch.rows.length - 1]?.cursor ?? after;
          }
        }
      }
      this.clients.add(client);
    });
  }

  unsubscribe(client: StreamClient): void {
    if (this.clients.delete(client)) {
      try {
        client.close();
      } catch {
        // already closed
      }
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const c of [...this.clients]) this.unsubscribe(c);
    await this.reader.stop();
  }
}

/**
 * One SSE frame. The id is the horizon, not the row's own cursor: a client
 * that resumes from it gets a complete replay (possibly including this row
 * again, which it drops by data.id).
 */
export function formatEvent(row: OutboxRow, horizon: Cursor): string {
  const data = {
    id: row.id,
    cursor: encodeCursor(row.cursor),
    type: row.type,
    entityId: row.entityId,
    payload: row.payload,
    createdAt: row.createdAt,
  };
  return `id: ${encodeCursor(horizon)}\nevent: ${row.type}\ndata: ${JSON.stringify(data)}\n\n`;
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
