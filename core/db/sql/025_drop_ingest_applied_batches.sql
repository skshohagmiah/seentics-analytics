-- One marker, not two.
--
-- `ingest_batches.completed_at` and `ingest_applied_batches` recorded the same fact —
-- this batch has landed — because they were built at different times. `applyBatchOnce`
-- now flips `completed_at` inside the write's own transaction, which is the guarantee the
-- separate table existed to provide, so the table, its prune and its index are dead.
--
-- Safe across a rolling deploy: a batch applied by the old code already had `completed_at`
-- set afterwards, so the new code's `WHERE completed_at IS NULL` skips it just the same.
DROP TABLE IF EXISTS ingest_applied_batches;
