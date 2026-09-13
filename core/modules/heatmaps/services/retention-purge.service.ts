import { sql } from "../../../db";
import { deleteS3Objects } from "../../../platform/lib/s3";
import { log as baseLog } from "../../../platform/lib/logger";
import type {
  RetentionCutoffs,
  RetentionOptions,
  RetentionPurge,
  RetentionTarget,
} from "../../../platform/retention/interfaces";
import { affectedRows } from "../../../platform/retention";

const log = baseLog.child({ category: "retention" });

/**
 * Deletes aged heatmap aggregates and layout snapshots.
 *
 * Both tables are keyed by the website UUID and cast it explicitly — a `websiteId` here
 * would be a type error at the driver rather than a silent no-match, which is the one
 * place in this codebase where the two-identifier confusion fails loudly.
 *
 * Snapshot objects are removed before their rows, and the rows are only deleted when
 * there were snapshots to begin with, preserving the original behaviour: a website
 * with no aged snapshots issues no DELETE at all.
 */
export class HeatmapRetentionPurge implements RetentionPurge {
  readonly name = "heatmaps";

  async purge(
    target: RetentionTarget,
    cutoffs: RetentionCutoffs,
    options: RetentionOptions,
  ): Promise<Record<string, number>> {
    const websiteId = target.websiteId;

    const points = await sql`
      DELETE FROM heatmap_points
      WHERE website_id = ${websiteId}::uuid
        AND last_updated < ${cutoffs.heatmap}
    `;

    let snapshotRows = 0;
    let snapshotObjects = 0;

    const shots = await sql<{ s3_key: string }[]>`
      SELECT s3_key FROM heatmap_page_snapshots
      WHERE website_id = ${websiteId}::uuid
        AND updated_at < ${cutoffs.heatmap}
    `;

    if (shots.length > 0) {
      const keys = shots.map((s) => s.s3_key).filter(Boolean);
      try {
        await deleteS3Objects(options.heatmapBucket, keys);
        snapshotObjects += keys.length;
      } catch (e) {
        log.warn({
          msg: "retention_heatmap_snapshot_s3_failed",
          website_id: websiteId,
          n: keys.length,
          err: String(e),
        });
      }

      const deleted = await sql`
        DELETE FROM heatmap_page_snapshots
        WHERE website_id = ${websiteId}::uuid
          AND updated_at < ${cutoffs.heatmap}
      `;
      snapshotRows += affectedRows(deleted);
    }

    return {
      heatmapPointRows: affectedRows(points),
      heatmapSnapshotRows: snapshotRows,
      heatmapSnapshotS3Deleted: snapshotObjects,
    };
  }
}
