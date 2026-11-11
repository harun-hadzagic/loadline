"use client";

// The browser side of the event stream. EventSource reconnects on its own and
// sends Last-Event-ID; this wrapper adds a status for the indicator, a tiny
// subscriber API, and a debug handle (window.__loadlineStream) the two-browser
// Playwright tests use to cut and restore the connection on purpose.

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline";

export interface StreamEvent {
  /** The outbox row id: unique per change, the de-duplication key. */
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

export class LoadlineStream {
  private source: EventSource | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private _status: StreamStatus = "connecting";
  private lastEventId: string | null = null;
  private paused = false;
  /** Every event id received, in order: lets a test assert exactly-once delivery. */
  readonly received: string[] = [];
  private seen = new Set<string>();

  constructor(private readonly url = "/api/events") {}

  get status(): StreamStatus {
    return this._status;
  }

  connect(): void {
    if (this.source || this.paused) return;
    // A manual reconnect carries the cursor as a query parameter, because a
    // fresh EventSource has no Last-Event-ID yet.
    const url = this.lastEventId
      ? `${this.url}?after=${encodeURIComponent(this.lastEventId)}`
      : this.url;
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
    if (type === "hello") {
      this.setStatus("live");
      return;
    }
    let data: Partial<StreamEvent> = {};
    try {
      data = JSON.parse(raw.data) as Partial<StreamEvent>;
    } catch {
      return;
    }
    if (type === "resync") {
      this.emit({
        id: "",
        cursor: raw.lastEventId,
        type,
        entityId: null,
        payload: data as Record<string, unknown>,
        createdAt: "",
      });
      return;
    }
    const id = String((data as { id?: unknown }).id ?? "");
    if (id && this.seen.has(id)) return; // a replay may repeat a row: harmless, and ignored
    if (id) {
      this.seen.add(id);
      this.received.push(id);
    }
    this.emit({
      id,
      cursor: raw.lastEventId,
      type,
      entityId: data.entityId ?? null,
      payload: data.payload ?? {},
      createdAt: data.createdAt ?? "",
    });
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
