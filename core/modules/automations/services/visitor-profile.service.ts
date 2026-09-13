/**
 * Writing the visitor profile.
 *
 * `loadUserProfile` in `evaluate.service.ts` has always read this table to build the
 * condition context, but nothing ever wrote a row — the only writer was an
 * `upsertUserProfile` method whose own comment recorded that no endpoint called it.
 * So `country`, `device`, `visitCount` and every custom property resolved to
 * `undefined`, the evaluator failed closed as designed, and any condition naming them
 * was permanently false. Silently: a fact that cannot be resolved looks exactly like a
 * fact that is false.
 *
 * Nothing new is collected to fix that. Every value here already arrives on the
 * `/tracker/collect` request — the MaxMind lookup and the Bowser user-agent parse are
 * done once per batch as `ingestMeta`, and the visitor id rides on the events. This
 * service just persists what was already in hand.
 *
 * It persists it *in batches*, off the durable queue, which is the second thing this file
 * has been through. The first version wrote one un-awaited upsert per `/collect`, which
 * made the profile the only per-request database write on a path whose entire design is
 * that it never makes one. It now takes the same route as every other category: buffered
 * by `CollectBuffer`, committed to `ingest_batches`, applied by `BatchWorker`.
 */

import { applyBatchOnceSql } from "../../../platform/idempotency";
import {
  coalesceProfiles,
  upsertVisitorProfilesBatch,
} from "../repositories/visitor-profile-batch.repository";
import type { VisitorProfileWrite, VisitorProfileWriter } from "../interfaces";

export class VisitorProfileService implements VisitorProfileWriter {
  /**
   * Apply one queued batch of profiles.
   *
   * Guarded by the batch marker because two of the columns accumulate: `visit_count` and
   * `total_page_views` would both inflate on a redelivery, and a re-delivered batch is the
   * normal case under at-least-once delivery, not an exception.
   *
   * Throws on failure. That is deliberate and is the difference from the previous
   * behaviour, which swallowed and logged: the caller is the ingest worker now, not an
   * HTTP handler, and a swallowed error there reads as a successful apply and marks the
   * batch completed.
   */
  async writeBatch(batchId: string, rows: readonly VisitorProfileWrite[]): Promise<number> {
    // Defensive rather than load-bearing — `CollectBuffer` coalesces before it
    // enqueues — but the statement below is an error, not a double count, if two rows in
    // one batch name the same visitor. Cheap enough to guarantee here too.
    const unique = coalesceProfiles(rows);
    if (unique.length === 0) return 0;

    const { applied, rowCount } = await applyBatchOnceSql(batchId, (tx) =>
      upsertVisitorProfilesBatch(tx, unique),
    );
    return applied ? rowCount : 0;
  }
}
