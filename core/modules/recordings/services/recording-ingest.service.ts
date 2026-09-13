import { env } from "../../../config";
import { getNextReplayChunkSequence, uploadSessionChunkGzip } from "../../../platform/lib/s3";
import { SessionChunkBuffer, type WarmTail } from "./session-chunk-buffer.service";
import { applyBatchOnce } from "../../../platform/idempotency";
import { upsertSessionMetaBatch, type SessionUpsertRow } from "../repositories/recording.repository";
import { compareReplayEnvelopeEvents } from "./replay-event-ordering.service";
import type { AnalyticsIngestMeta } from "../../../platform/lib/analytics-ingest-meta";
import type { TrackerEvent } from "../../../platform/lib/types";
import type { RecordingIngest } from "../interfaces";
import { recordingEventsIn } from "./tracker-recording-event-mapping.service";
import { log as baseLog } from "../../../platform/lib/logger";

const log = baseLog.child({ category: "replay" });

/** Sessions per metadata statement. One `applyBatchOnce` marker still covers the whole batch. */
const pgStatementSize = 64;

type RageClick = { ts: number; x: number; y: number };

/**
 * Widest epoch-ms this module will carry out of a client payload.
 *
 * `Number.isFinite` is not a tight enough filter on its own: the value ends up in the
 * `data` jsonb as `_snc_re_end` and is cast to `bigint` in the metadata upsert, so a
 * fractional or out-of-range timestamp aborts the whole statement and takes every other
 * session in the same batch down with it. `1e21` and `1700000000000.5` both reach that
 * cast unharmed without this.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** An integral, in-range epoch-ms, or null when the value cannot be one. */
function sanitizeEpochMs(v: number): number | null {
  if (!Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  if (n < 0 || n > MAX_EPOCH_MS) return null;
  return n;
}

/** rrweb `eventWithTime.timestamp` on tracker payloads (`type: 'rrweb'`, `data` = emit object). */
function rrwebPayloadTimelineMs(data: unknown): number | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = (data as Record<string, unknown>).timestamp;
  if (typeof raw === "number") return sanitizeEpochMs(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? sanitizeEpochMs(n) : null;
  }
  return null;
}

/** Safety bound so a rogue client clock can't store an absurd duration. Real sessions
 *  are capped at 30 min by the tracker; envelope ts is clamped to [now−48h, now+5min]. */
const MAX_REPLAY_DURATION_SECONDS = 24 * 60 * 60;

/**
 * Widest activity span of the batch across ALL session events — rrweb, console,
 * network, and error — using each event's envelope `ts` (clamped upstream; for
 * rrweb events the tracker sets ts = the rrweb event timestamp, so this matches
 * the playback timeline). Basing duration on this instead of the rrweb-only span
 * means a visitor who reads a page for 30s without triggering DOM mutations still
 * reports real elapsed time, instead of collapsing to ~0.
 */
function replayActivitySpanMs(batch: SessionBatch): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const e of batch.events) {
    // Prefer the rrweb event timestamp when present; fall back to the envelope ts.
    let t = e.type === "rrweb" ? rrwebPayloadTimelineMs(e.data) : null;
    if (t == null) {
      const n = typeof e.ts === "number" ? e.ts : Number(e.ts);
      t = sanitizeEpochMs(n);
    }
    if (t == null) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (min === Infinity || max === -Infinity || max < min) return null;
  return { min, max };
}

function replayDurationSecondsFromBatch(batch: SessionBatch): number {
  const span = replayActivitySpanMs(batch);
  if (!span) return 0;
  const secs = Math.floor((span.max - span.min) / 1000);
  return Math.min(MAX_REPLAY_DURATION_SECONDS, Math.max(0, secs));
}

function replayLatestEventMsForStorage(batch: SessionBatch, fallbackEnd: number): number {
  const span = replayActivitySpanMs(batch);
  if (span) return span.max;
  return sanitizeEpochMs(fallbackEnd) ?? 0;
}

type SessionBatch = {
  websiteId: string;
  events: Record<string, unknown>[];
  clicks: RageClick[];
  hasErrors: boolean;
  hasFullSnapshot: boolean;
  startTs: number;
  endTs: number;
  /** First event’s request-level UA/geo (same as analytics ingest). */
  ingestMeta?: AnalyticsIngestMeta;
};

/** The request-level context the list view renders, resolved once per session. */
type SessionEnvironment = {
  browser: string;
  device: string;
  os: string;
  country: string;
  entryPage: string;
};

type SessionWork = {
  sessionId: string;
  batch: SessionBatch;
  env: SessionEnvironment;
  urlTransitions: number;
  firstUrl: string;
  lastUrl: string;
  durationSeconds: number;
  tsToUse: number;
  rageClicks: boolean;
};

/** Origin+path only — hash/query churn must not count as a new page. */
function normalizeReplayPageUrl(u: unknown): string {
  if (typeof u !== "string" || !u) return "";
  try {
    const p = new URL(u);
    return p.origin + p.pathname;
  } catch {
    return u;
  }
}

export class RecordingIngestService implements RecordingIngest {
  private spool: SessionChunkBuffer;
  private bucket: string;

  constructor() {
    const c = env();
    this.bucket = c.s3.bucket;
    this.spool = new SessionChunkBuffer({
      chunkFlushMs: c.replayChunkFlushMs,
      idlePurgeMs: c.spoolIdleMs,
      getInitialSequence: async (websiteId, sessionId) =>
        getNextReplayChunkSequence(this.bucket, websiteId, sessionId),
      onChunkFlush: async (websiteId, sessionId, sequence, events) => {
        await uploadSessionChunkGzip(this.bucket, websiteId, sessionId, sequence, events);
      },
    });
    this.spool.start();
  }

  async shutdown(): Promise<void> {
    await this.spool.flushAll();
    this.spool.stop();
  }

  /**
   * Ingest tracker-shaped events (same envelope as Go TrackerEvent).
   *
   * Throws when the metadata write fails, so the ingest worker retries the batch rather
   * than marking it applied. The write used to be buffered onto a timer and awaited by
   * nobody: a dropped or failed flush left chunks in object storage with no `sequence = 0`
   * row, and a recording with no row is invisible to the session list, undeletable from
   * the dashboard, and unreachable by retention — which enumerates its work from that
   * very table.
   */
  async processEvents(batchId: string, events: TrackerEvent[]): Promise<void> {
    // Which types make up a recording is this module's answer, so the filter is here
    // rather than in ingest.
    events = recordingEventsIn(events);
    const grouped = new Map<string, SessionBatch>();

    for (const ev of events) {
      if (!ev.sid) continue;
      let b = grouped.get(ev.sid);
      if (!b) {
        b = {
          websiteId: ev.websiteId,
          events: [],
          clicks: [],
          hasErrors: false,
          hasFullSnapshot: false,
          startTs: ev.ts,
          endTs: ev.ts,
        };
        grouped.set(ev.sid, b);
      }
      if (ev.ingestMeta && !b.ingestMeta) b.ingestMeta = ev.ingestMeta;
      b.events.push({
        type: ev.type,
        ts: ev.ts,
        url: ev.url ?? "",
        sid: ev.sid,
        vid: ev.vid ?? "",
        data: ev.data ?? {},
      });
      if (ev.ts < b.startTs) b.startTs = ev.ts;
      if (ev.ts > b.endTs) b.endTs = ev.ts;

      if (ev.type === "session_error") b.hasErrors = true;
      if (ev.type === "rrweb" && ev.data) {
        const rrwEvType = Number(ev.data.type);
        if (rrwEvType === 2) b.hasFullSnapshot = true;
        if (rrwEvType === 3) {
          const inner = ev.data.data as Record<string, unknown> | undefined;
          if (inner) {
            const src = Number(inner.source);
            const ct = Number(inner.type);
            if (src === 2 && ct === 2) {
              const x = Number(inner.x);
              const y = Number(inner.y);
              const ts = rrwebPayloadTimelineMs(ev.data);
              b.clicks.push({ ts: ts ?? ev.ts, x, y });
            }
          }
        }
      }
    }

    const work: SessionWork[] = [];
    for (const [sessionId, batch] of grouped) {
      sortBatchEvents(batch.events);
      if (batch.clicks.length > 1) batch.clicks.sort((a, c) => a.ts - c.ts);

      /**
       * Count pages from envelope URL transitions, NOT from FullSnapshots.
       * The tracker checkpoints a FullSnapshot every 60s (`checkoutEveryNms`),
       * so snapshot counting inflated pages_viewed by roughly one per minute
       * of session time. Cross-batch boundaries are handled in the upsert via
       * first/last URL stored in the sequence-0 row's data jsonb.
       */
      let urlTransitions = 0;
      let firstUrl = "";
      let lastUrl = "";
      for (const e of batch.events) {
        const u = normalizeReplayPageUrl(e.url);
        if (!u) continue;
        if (!firstUrl) {
          firstUrl = u;
          lastUrl = u;
          continue;
        }
        if (u !== lastUrl) {
          urlTransitions++;
          lastUrl = u;
        }
      }

      // Populate metadata for every session that has any events — not just FullSnapshot ones.
      // Network/error-only sessions (no rrweb recording) still need browser/OS/country for the list view.
      const entryURL =
        batch.events.length > 0 && typeof batch.events[0]!.url === "string"
          ? (batch.events[0]!.url as string)
          : "";
      const im = batch.ingestMeta;
      const environment: SessionEnvironment = {
        browser: (im?.browser ?? "").trim() || "Unknown",
        device: (im?.device ?? "").trim() || "Unknown",
        os: (im?.os ?? "").trim() || "Unknown",
        country: (im?.country ?? "").trim(),
        entryPage: entryURL,
      };

      let tsToUse = batch.endTs;
      if (batch.hasFullSnapshot) tsToUse = batch.startTs;

      work.push({
        sessionId,
        batch,
        env: environment,
        urlTransitions,
        firstUrl,
        lastUrl,
        durationSeconds: replayDurationSecondsFromBatch(batch),
        tsToUse,
        rageClicks: hasRageClickPattern(batch.clicks),
      });
    }

    if (work.length === 0) return;

    const rows: SessionUpsertRow[] = work.map((w) => ({
      websiteId: w.batch.websiteId,
      sessionId: w.sessionId,
      tsMs: w.tsToUse,
      latestEventMs: replayLatestEventMsForStorage(w.batch, w.batch.endTs),
      browser: w.env.browser,
      device: w.env.device,
      os: w.env.os,
      country: w.env.country,
      entryPage: w.env.entryPage,
      urlTransitions: w.urlTransitions,
      firstUrl: w.firstUrl,
      lastUrl: w.lastUrl,
      durationSeconds: w.durationSeconds,
      hasRageClicks: w.rageClicks,
      hasErrors: w.batch.hasErrors,
    }));

    /**
     * Metadata first, chunks second.
     *
     * `pages_viewed` accumulates, so a redelivered batch inflates it — the marker is what
     * stops that. Writing the rows before spooling also means a failed write leaves nothing
     * buffered: the retry re-does both halves from a clean slate instead of appending the
     * same events to the spool a second time.
     */
    const { applied } = await applyBatchOnce(batchId, async (tx) => {
      let written = 0;
      for (let i = 0; i < rows.length; i += pgStatementSize) {
        written += await upsertSessionMetaBatch(tx, batchId, rows.slice(i, i + pgStatementSize));
      }
      return written;
    });

    if (!applied) {
      log.debug({ msg: "replay_batch_redelivered", batch_id: batchId, sessions: work.length });
      return;
    }

    for (const w of work) {
      try {
        this.spool.push(w.batch.websiteId, w.sessionId, w.batch.events);
      } catch (e) {
        // The metadata row is already committed, so the session stays visible and
        // deletable — it just has fewer events than it should.
        log.error({ msg: "replay_spool_push_failed", session_id: w.sessionId, err: String(e) });
      }
    }
  }

  warmChunks(websiteId: string, sessionId: string): WarmTail | null {
    return this.spool.warmChunks(websiteId, sessionId);
  }

  removeSpool(websiteId: string, sessionId: string): void {
    this.spool.remove(websiteId, sessionId);
  }
}

function sortBatchEvents(events: Record<string, unknown>[]): void {
  events.sort(compareReplayEnvelopeEvents);
}

function hasRageClickPattern(clicks: RageClick[]): boolean {
  for (let i = 0; i < clicks.length; i++) {
    let count = 1;
    for (let j = i + 1; j < clicks.length; j++) {
      if (clicks[j]!.ts - clicks[i]!.ts > 1000) break;
      const dx = clicks[j]!.x - clicks[i]!.x;
      const dy = clicks[j]!.y - clicks[i]!.y;
      if (dx * dx + dy * dy <= 2500) count++;
    }
    if (count >= 3) return true;
  }
  return false;
}

let _engine: RecordingIngestService | null = null;

/**
 * The process-wide service.
 *
 * Creates one on first use, so an early ingest still has somewhere to go, and constructing
 * it is what arms the chunk flush timer and opens the storage client. Still an accessor
 * rather than an injected dependency because `session-detail` and `session-delete` need
 * the live warm tail from free functions; injecting it there means threading it through
 * the service and the routes, which is a change worth making on its own.
 */
export function recordingIngestService(): RecordingIngestService {
  if (!_engine) _engine = new RecordingIngestService();
  return _engine;
}

/** Shut down and forget the engine, if one was ever built. Constructs nothing. */
export async function stopRecordingIngestService(): Promise<void> {
  const engine = _engine;
  _engine = null;
  if (engine) await engine.shutdown();
}
