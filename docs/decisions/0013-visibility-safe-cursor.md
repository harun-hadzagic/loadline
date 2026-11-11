# 0013 · The visibility-safe cursor, and eager delivery above it

**Date:** 2026-11-11 · **Phase:** 3

## Context

Identity values are handed out when a row is inserted, not when its transaction commits. A reader that takes `id > last_id` can therefore see id 7 (committed) before id 6 (whose transaction is still open), advance its cursor to 7, and never deliver 6. The cursor test (`packages/db/test/db/cursor.test.ts`) opens two transactions, commits the later one first, and asserts both rows arrive in a stable order.

## Decision

Each outbox row records `txid` (`pg_current_xact_id()`, an `xid8`). The stream orders rows by `(txid, id)`, and a cursor is that pair, encoded `txid:id`.

**The horizon.** The spec's rule, "only read rows whose `txid` is below `pg_snapshot_xmin(pg_current_snapshot())`", defines a *horizon*: every row at or below `(xmin − 1, max id)` is final, because every transaction that could still insert an earlier row has finished. The horizon is what browsers get as the SSE `id:` and resume from with `Last-Event-ID`; a replay from it is complete by construction, and it never moves backwards.

**Eager delivery above the horizon.** The xmin rule alone has a liveness problem that the two-browser tests exposed: `xmin` is the oldest running transaction *anywhere in the cluster*, so a long report, an idle-in-transaction connection, or a test suite in another database freezes every board until it ends. The hub therefore reads committed rows above the horizon too (`pg_visible_in_snapshot(txid, snapshot)`, one statement, one snapshot) and delivers them at once, remembering their ids until the horizon passes them so a later drain does not send them twice. A browser that reconnects replays from the horizon and may see such a row again, which it drops by row id. The client-side rule "apply by entity id and version, ignore anything older" makes any remaining duplicate harmless.

So: the *resume cursor* is still exactly the spec's visibility-safe cursor; the *delivery* is as fast as commit visibility, independent of unrelated long transactions.

**Replay under the lock.** Subscribing a reconnecting client (replay, then switch to live) and draining new rows run under one lock, so no row can fall between a client's replay and its first live event.

**The rules a drain follows** (each closes a hole the Phase 3 review proved):

1. Rows, `xmin`, `xmax` and the in-progress list come from *one statement*, even when there are no rows. An empty read that took its horizon from a second, newer snapshot would let a transaction committing in between fall below the horizon unread.
2. The horizon advances once per drain, to the horizon of the drain's *first* read, never per page. A failed read advances nothing.
3. Every SSE frame's `id:` is `min(row cursor, horizon of the read that produced it)`; `hello` during a replay carries the client's own cursor. Resuming from any frame's id yields every later row.
4. The next drain reads only rows from transactions that were in progress at the previous snapshot or newer than its `xmax`, so one long transaction does not make every drain re-read everything.
5. "Can this client be replayed from its cursor?" is answered by a prune watermark (`app.outbox_watermark`, the highest cursor ever deleted), read after the replay, not by the oldest surviving row.

`apps/web/test/db/hub.test.ts` and `packages/db/test/db/cursor-committed.test.ts` exercise each rule against the real database.

## Rejected

- `id > last_id`: the bug described above.
- Waiting for the horizon before delivering anything (the rule taken literally): correct, but one stuck transaction in the cluster stalls the whole product, and the e2e suite showed it within an hour.
- A gapless sequence (a counter table updated in every write transaction): serialises all writers on one row.
- Commit timestamps (`track_commit_timestamp`): not monotonic across sessions, and not available per row without another join.
