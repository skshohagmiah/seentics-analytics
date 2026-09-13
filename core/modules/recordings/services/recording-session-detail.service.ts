import { env } from "../../../config";
import { recordingIngestService } from "./recording-ingest.service";
import { getSessionMeta } from "../repositories/recording.repository";
import { presignGet, locateBundle, getJsonGzip, listSessionReplayChunks } from "../../../platform/lib/s3";
import { compareReplayEnvelopeEvents } from "./replay-event-ordering.service";
import { replayNotReady, timestampToIso } from "./recording-query-normalization.service";
import type {
  RecordingChunkUrl,
  RecordingDetail,
  RecordingDetailMeta,
} from "../interfaces";

/** Chunk objects stored for one session, lowest sequence first. */
async function listSessionChunkRows(
  bucket: string,
  websiteId: string,
  sessionId: string,
): Promise<{ sequence: number; key: string }[]> {
  const rows = await listSessionReplayChunks(bucket, websiteId, sessionId);
  const bySeq = new Map<number, string>();
  for (const r of rows) {
    if (!bySeq.has(r.sequence)) bySeq.set(r.sequence, r.key);
  }
  return [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sequence, key]) => ({ sequence, key }));
}

/**
 * One recording with its ordered event stream.
 *
 * The in-memory tail is read **after** the object listing, never before. A spool flush
 * between the two used to hand the same events back twice — once as a listed chunk and
 * once as `warm_chunks` — and the player appends the warm tail last via rrweb's live-mode
 * `addEvent`, which assumes chronologically increasing input. Reading in this order means
 * anything already flushed is out of the buffer, so the two sets cannot overlap.
 */
export async function getReplaySessionDetail(
  websiteId: string,
  sessionId: string,
): Promise<RecordingDetail> {
  const sid = sessionId.trim();
  const engine = recordingIngestService();
  const cfg = env();

  const metaRow = await getSessionMeta(websiteId, sid);
  const meta: RecordingDetailMeta | null = metaRow
    ? {
        sessionId: metaRow.sessionId,
        websiteId: metaRow.websiteId,
        browser: metaRow.browser,
        device: metaRow.device,
        os: metaRow.os,
        country: metaRow.country,
        entryPage: metaRow.entryPage,
        startedAt: timestampToIso(metaRow.startedAt),
        hasRageClicks: metaRow.hasRageClicks,
        hasErrors: metaRow.hasErrors,
        durationSeconds: metaRow.durationSeconds,
        pagesViewed: metaRow.pagesViewed,
      }
    : null;

  const bucket = cfg.s3.bucket;
  const expMs = cfg.presignTtlMs;
  const deadline = new Date(Date.now() + expMs).toISOString();

  let chunkRows = await listSessionChunkRows(bucket, websiteId, sid);
  const warm = engine.warmChunks(websiteId, sid);

  /**
   * A flush that landed between the listing and the tail read leaves a chunk in storage
   * that this response would not mention — a gap in the middle of playback. One re-list
   * closes it; the tail is already known not to contain those events.
   */
  if (warm?.flushedThrough != null) {
    const highestListed = chunkRows.length > 0 ? chunkRows[chunkRows.length - 1]!.sequence : -1;
    if (warm.flushedThrough > highestListed + 1) {
      chunkRows = await listSessionChunkRows(bucket, websiteId, sid);
    }
  }

  const warmFlat: Record<string, unknown>[] = warm ? warm.events : [];

  /** Time-based immutable chunks + optional in-memory tail. */
  if (chunkRows.length > 0) {
    const replay_chunk_urls: RecordingChunkUrl[] = await Promise.all(
      chunkRows.map(async ({ sequence, key }) => ({
        sequence,
        url: await presignGet(bucket, key, expMs),
        expires_at: deadline,
      })),
    );
    const maxSeq = chunkRows[chunkRows.length - 1]!.sequence;
    const warmSeq = maxSeq + 1;
    const warm_chunks =
      warmFlat.length > 0
        ? [
            {
              sequence: warmSeq,
              data: warmFlat as unknown[],
              timestamp: timestampToIso(new Date()),
            },
          ]
        : undefined;
    return {
      status: 200,
      body: {
        session_id: sid,
        meta,
        /** Lets clients/DevTools confirm immutable S3 chunk path vs legacy bundle. */
        replay_storage: "chunks" as const,
        replay_chunk_count: chunkRows.length,
        replay_chunk_urls,
        ...(warm_chunks ? { warm_chunks } : {}),
        recording_pending: false,
      },
    };
  }

  const key = await locateBundle(bucket, websiteId, sid);

  /** Legacy single bundle merged with warm tail. */
  if (warmFlat.length > 0) {
    let s3Events: Record<string, unknown>[] | null = null;
    if (key) {
      try {
        s3Events = await getJsonGzip(bucket, key);
      } catch {
        s3Events = null;
      }
    }
    const merged: Record<string, unknown>[] = [];
    if (s3Events?.length) merged.push(...s3Events);
    merged.push(...warmFlat);
    merged.sort(compareReplayEnvelopeEvents);
    return {
      status: 200,
      body: {
        session_id: sid,
        meta,
        replay_storage: "legacy_inline" as const,
        warm_chunks: [
          {
            sequence: 0,
            data: merged as unknown[],
            timestamp: timestampToIso(new Date()),
          },
        ],
        recording_pending: false,
      },
    };
  }

  if (!key) {
    if (!meta) return { status: 404, body: { error: replayNotReady } };
    return {
      status: 200,
      body: {
        session_id: sid,
        meta,
        replay_storage: "pending" as const,
        recording_pending: true,
      },
    };
  }

  const url = await presignGet(bucket, key, expMs);
  return {
    status: 200,
    body: {
      session_id: sid,
      meta,
      replay_storage: "bundle" as const,
      replay_url: url,
      replay_url_expires_at: deadline,
      recording_pending: false,
    },
  };
}
