/**
 * The retention sweep's contract with the modules that own the data.
 *
 * Retention is the one place in the system that has to touch every module's tables,
 * which made it the worst boundary violation left: a single 200-line function issuing
 * `DELETE FROM analytics_events`, `automation_events`, `session_replays`,
 * `heatmap_points` and `heatmap_page_snapshots` — five tables owned by four modules
 * that knew nothing about it. A schema change in any of them broke deletion silently,
 * in code no one running that module would think to look at.
 *
 * Inverted: retention owns the *policy* (how long each kind of data lives, including
 * per-website overrides) and each module owns the *deletion* of its own rows.
 */

import type { AppConfig } from "../../../config";

/**
 * The website being swept.
 *
 * One identifier: `websites.id`, which every table keys on. This used to carry two,
 * because `analytics_events` and `session_replays` were keyed by a shorter public id
 * while everything else used the UUID — and a purge that mixed them up deleted nothing
 * and reported success.
 */
export type RetentionTarget = {
  websiteId: string;
};

/**
 * Effective cut-offs for one website, after per-website overrides are merged.
 *
 * Four separate dates rather than one because the kinds age out at different rates:
 * replays and heatmap images are large and short-lived, funnel and automation history
 * is small and kept longer.
 */
export type RetentionCutoffs = {
  /** General analytics events older than this go. */
  analytics: Date;
  /** Funnel events and automation execution history. */
  funnelAutomation: Date;
  /** Session recordings, including their stored chunks. */
  replay: Date;
  /** Heatmap aggregates and layout snapshots. */
  heatmap: Date;
};

export type RetentionOptions = {
  /**
   * Rows per batch for the deletions that page.
   *
   * Recordings delete in batches because each row also implies object-storage
   * deletes; an unbounded sweep would hold a transaction open across thousands of
   * network calls.
   */
  batchSize: number;
  /** Object-storage bucket holding session recordings. */
  bucket: string;
  /** Bucket holding heatmap screenshots and layout snapshots; may equal `bucket`. */
  heatmapBucket: string;
};

/**
 * One module's share of a retention sweep.
 *
 * Implementations must be safe to call repeatedly — the sweep runs daily and may be
 * triggered manually on top of that — and must not throw for a website that simply
 * has nothing to delete.
 *
 * Failures should be logged and swallowed per website rather than propagated: one
 * site's unreachable S3 prefix must not stop the sweep for every other site, which is
 * the behaviour the original single-function version had.
 */
export interface RetentionPurge {
  /** Stable identifier, used in logs and to attribute returned counts. */
  readonly name: string;

  /**
   * Delete this module's aged rows for one website.
   *
   * Returns counts keyed by metric name; the orchestrator sums them across websites
   * into the sweep total. Keys are the module's own choice and appear verbatim in the
   * reported stats, so they should stay stable — dashboards and the internal endpoint
   * read them.
   */
  purge(
    target: RetentionTarget,
    cutoffs: RetentionCutoffs,
    options: RetentionOptions,
  ): Promise<Record<string, number>>;
}

/**
 * Triggering a sweep, as the scheduler and the internal route see it.
 *
 * Both used to name `RetentionService` itself, which made a cron job and an HTTP
 * handler depend on the class that holds the policy, the single-flight guard and the
 * per-module fan-out. They only ever call one method.
 */
export interface RetentionRunner {
  /**
   * Run a sweep, or return `null` when retention is disabled or one is already
   * in flight. The already-running case is not an error: the nightly cron and a
   * manual trigger are both expected to fire.
   */
  runSafely(cfg: AppConfig): Promise<({ websitesProcessed: number } & Record<string, number>) | null>;
}

/**
 * The websites retention iterates over.
 *
 * The one table retention used to read directly — a `SELECT id, website_id FROM websites`
 * in `retention.service.ts`, against a table the websites module owns. Declared here
 * because retention is the consumer and dictates the shape it needs: both identifiers,
 * every website, no filtering.
 */
export interface RetentionSiteSource {
  /**
   * Every website in the deployment, as id pairs.
   *
   * Unfiltered on purpose: retention sweeps everything, and a website excluded here
   * would silently keep its data forever.
   */
  listAllSites(): Promise<readonly RetentionTarget[]>;
}
