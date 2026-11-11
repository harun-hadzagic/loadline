"use client";

// The browser side of the event stream. EventSource reconnects on its own and
// sends Last-Event-ID; this wrapper adds a status for the indicator, a tiny
// subscriber API, and a debug handle (window.__loadlineStream) the two-browser
// Playwright tests use to cut and restore the connection on purpose.
//
// De-duplication by row id lives in the cache bridge (use-event-stream.ts),
// which marks a row id as applied only after the cache update succeeded: a
// frame whose fetch failed is not "seen", so a replay can deliver it again.

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline";

export interface StreamEvent {
  /** The outbox row id: unique per change, the de-duplication key. Empty for hello/resync. */
  id: string;
  /** The resume cursor that came with the frame (the server's safe horizon). */
  cursor: string;
  type: string;
  entityId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

type Listener = (event: StreamEvent) => void;
type StatusListener = (status: StreamStatus) => void;

const EVENT_TYPES = [
  "hello",
  "resync",
  "load.created",
  "load.updated",
  "driver.created",
  "driver.updated",
  "truck.created",
  "truck.updated",
  "position.updated",
  "stop.arrived",
];

/** Row ids remembered per tab; older ones are forgotten (a replay that far back is a resync anyway). */
const MAX_APPLIED = 5_000;

export class LoadlineStream {
  private source: EventSource | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private _status: StreamStatus = "connecting";
  private lastEventId: string | null = null;
  private paused = false;
  /** Row ids applied to the cache, in order: lets a test assert exactly-once delivery. */
  readonly received: string[] = [];
  private applied = new Set<string>();

  constructor(private readonly url = "/api/events") {}

  get status(): StreamStatus {
    return this._status;
  }

  /** @param after a cursor to resume from on the first connection (a manual reconnect uses the last id). */
  connect(after?: string | null): void {
    if (this.source || this.paused) return;
    const cursor = this.lastEventId ?? after ?? null;
    const url = cursor ? `${this.url}?after=${encodeURIComponent(cursor)}` : this.url;
    const es = new EventSource(url);
    this.source = es;
    this.setStatus(this.lastEventId ? "reconnecting" : "connecting");
    es.onopen = () => this.setStatus("live");
    es.onerror = () => {
      // EventSource retries by itself (retry: hint); CLOSED means it gave up.
      this.setStatus(es.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
      if (es.readyState === EventSource.CLOSED) {
        this.source = null;
        if (!this.paused) setTimeout(() => this.connect(), 3_000);
      }
    };
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (raw) => this.handle(type, raw as MessageEvent<string>));
    }
  }

  private handle(type: string, raw: MessageEvent<string>): void {
    if (raw.lastEventId) this.lastEventId = raw.lastEventId;
    let data: Partial<StreamEvent> = {};
    try {
      data = JSON.parse(raw.data) as Partial<StreamEvent>;
    } catch {
      return;
    }
    if (type === "hello") this.setStatus("live");
    const id =
      type === "hello" || type === "resync" ? "" : String((data as { id?: unknown }).id ?? "");
    if (id && this.applied.has(id)) return; // a replay may repeat a row the cache already has
    this.emit({
      id,
      cursor: raw.lastEventId,
      type,
      entityId: data.entityId ?? null,
      payload: (data.payload ?? data ?? {}) as Record<string, unknown>,
      createdAt: data.createdAt ?? "",
    });
  }

  /** Called by the cache bridge once an event has been applied; only then does it count as seen. */
  markApplied(id: string): void {
    if (!id || this.applied.has(id)) return;
    this.applied.add(id);
    this.received.push(id);
    if (this.applied.size > MAX_APPLIED) {
      const oldest = this.received.shift();
      if (oldest) this.applied.delete(oldest);
    }
  }

  private emit(event: StreamEvent): void {
    for (const l of this.listeners) l(event);
  }

  private setStatus(s: StreamStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const l of this.statusListeners) l(s);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this._status);
    return () => this.statusListeners.delete(listener);
  }

  /** Test hook: drop the connection and stay down until resume(). */
  pause(): void {
    this.paused = true;
    this.source?.close();
    this.source = null;
    this.setStatus("offline");
  }

  /** Test hook: reconnect with the last cursor, replaying what was missed. */
  resume(): void {
    this.paused = false;
    this.connect();
  }

  close(): void {
    this.paused = true;
    this.source?.close();
    this.source = null;
    this.setStatus("offline");
  }
}

declare global {
  interface Window {
    __loadlineStream?: LoadlineStream;
  }
}

/** One stream per tab, shared by every component and exposed for tests. */
export function getStream(): LoadlineStream {
  if (!window.__loadlineStream) {
    window.__loadlineStream = new LoadlineStream();
    window.__loadlineStream.connect();
  }
  return window.__loadlineStream;
}
