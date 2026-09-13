import {
  claimPendingBatches,
  countPendingBatches,
  countParkedBatches,
  enqueueBatch,
  markBatchFailed,
  pruneCompletedBatches,
  releaseBatchClaims,
} from "./batch-queue.repository";
import type { BatchQueue } from "../interfaces";

/**
 * The production `BatchQueue`, backed by Postgres.
 *
 * Separate from the worker on purpose: this module reaches the database connection through
 * `batch-queue.repository`, and keeping it out of the worker's import graph is what lets
 * the worker be unit-tested without one. Same arrangement as `postgresOutboxStore`.
 */
export const postgresBatchQueue: BatchQueue = {
  enqueue: enqueueBatch,
  claimPending: claimPendingBatches,
  markFailed: markBatchFailed,
  releaseClaims: releaseBatchClaims,
  countPending: countPendingBatches,
  countParked: countParkedBatches,
  pruneCompleted: pruneCompletedBatches,
};
