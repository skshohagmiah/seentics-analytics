import { env } from "../../../config";
import { recordingIngestService } from "./recording-ingest.service";
import { deleteSession } from "../repositories/recording.repository";
import { deleteSessionPrefix } from "../../../platform/lib/s3";

/**
 * Delete recordings and their stored chunks.
 *
 * Best-effort across the batch: object storage and the database can disagree after a
 * partial failure, and refusing to delete the rest because one object is already gone
 * would leave the user unable to clear anything.
 */
export async function batchDeleteReplaySessions(
  websiteId: string,
  sessionIds: string[],
) {
  const engine = recordingIngestService();
  const bucket = env().s3.bucket;

  // Remove all in-memory spools first (synchronous, no await)
  for (const sid of sessionIds) {
    engine.removeSpool(websiteId, sid);
  }

  // Delete S3 objects and DB records for all sessions in parallel
  await Promise.all(
    sessionIds.map(async (sid) => {
      try {
        await deleteSessionPrefix(bucket, websiteId, sid);
      } catch {
        // S3 delete is best-effort — still remove the DB record
      }
      await deleteSession(websiteId, sid);
    }),
  );
}
