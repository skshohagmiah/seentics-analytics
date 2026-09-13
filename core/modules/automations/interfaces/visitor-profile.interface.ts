/**
 * The visitor-profile write path, as automations offers it to the ingest edge.
 *
 * Same reason as `AutomationTriggerWriter`: ingest builds the profile row out of a
 * `/collect` batch it has already parsed, and must hand it over without importing
 * `services/visitor-profile.service`. That import was a compile-time edge from ingest
 * straight into this module's internals — the barrel note here has named
 * `VisitorProfileWriter` as the intended seam since the profile write was added, and
 * this is it.
 *
 * The write is batched and durable, and it did not used to be. `/collect` called it once
 * per request, un-awaited, so the profile was the only per-request database write on a path
 * built to avoid exactly that — and being `void`ed, it applied no backpressure when the
 * pool was already saturated. It now goes through the ingest queue like every other
 * category: buffered, committed to `ingest_batches`, applied by `BatchWorker`.
 *
 * Which is why this rejects on failure rather than swallowing. The caller is a worker that
 * retries and parks, not an HTTP handler that must answer regardless.
 */

/** One visitor's profile, as ingest has it after parsing a `/collect` batch. */
export type VisitorProfileWrite = {
  websiteId: string;
  /** The tracker's visitor id (`snc_vid`), which is what conditions are keyed on. */
  anonymousId: string;
  /** Set by `seentics.identify()`; left alone when absent so a later batch cannot clear it. */
  userId?: string | null;
  /** Traits from `seentics.identify()`. Merged into `properties`, not replacing it. */
  traits?: Record<string, unknown>;
  /** Pageviews in this batch, added to the running total. */
  pageViews: number;
  /** From `ingestMeta` — already resolved for the analytics rows. */
  country?: string | null;
  region?: string | null;
  city?: string | null;
  device?: string | null;
  browser?: string | null;
  os?: string | null;
  language?: string | null;
};

export interface VisitorProfileWriter {
  /**
   * Apply one queued batch of profiles. Returns the rows written, and 0 for a batch the
   * marker had already applied.
   *
   * `visit_count` and `total_page_views` accumulate, so applying a batch twice inflates
   * both. `batchId` is what prevents that — the write and its `ingest_applied_batches`
   * marker share one transaction, exactly as the analytics and heatmap writers do.
   */
  writeBatch(batchId: string, rows: readonly VisitorProfileWrite[]): Promise<number>;
}
