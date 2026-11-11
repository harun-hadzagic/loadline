-- 0008 Prune watermark, after the Phase 3 review.
-- The stream decided "can this client be replayed from its cursor?" by
-- comparing with the oldest kept row, which fails when the outbox is empty
-- (a quiet weekend prunes everything) and races the prune itself. The prune
-- now records the highest (txid, id) it has ever deleted; a client whose
-- cursor is at or below that watermark gets a resync. Not tenant data: one
-- row for the whole outbox, written only by app.prune_outbox() (as the owner),
-- read only by loadline_stream.

CREATE TABLE app.outbox_watermark (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  txid       xid8,
  outbox_id  bigint,
  pruned_at  timestamptz
);
INSERT INTO app.outbox_watermark (singleton) VALUES (true);
GRANT SELECT ON app.outbox_watermark TO loadline_stream;

CREATE OR REPLACE FUNCTION app.prune_outbox() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
DECLARE
  v_count bigint;
  v_txid xid8;
  v_id bigint;
BEGIN
  -- created_at is the transaction's start time, which is not cursor order;
  -- the watermark is therefore the highest cursor among the deleted rows.
  WITH gone AS (
    DELETE FROM app.outbox WHERE created_at < now() - interval '24 hours' RETURNING txid, id
  )
  SELECT count(*), max(txid), max(id) INTO v_count, v_txid, v_id FROM gone;
  IF v_count > 0 THEN
    UPDATE app.outbox_watermark
       SET txid = GREATEST(COALESCE(txid, v_txid), v_txid),
           outbox_id = CASE WHEN txid IS NULL OR v_txid > txid THEN v_id
                            WHEN v_txid = txid THEN GREATEST(outbox_id, v_id) ELSE outbox_id END,
           pruned_at = now()
     WHERE singleton;
  END IF;
  RETURN v_count;
END
$$;
