/**
 * Exactly-once application of a queued batch.
 *
 * Kept in `platform` rather than in ingest because the guarantee is not ingest's: any
 * write that can be redelivered needs it, and the outbox publisher reaches for the same
 * shape.
 */
export { applyBatchOnce, applyBatchOnceSql, type BatchApplication, type BatchTx } from "./apply-once";
export { batchIdFromContent, serializeBatch } from "./batch-id";
