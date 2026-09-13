import { compareReplayEnvelopeEvents } from "./replay-event-ordering.service";
import { log as baseLog } from "../../../platform/lib/logger";

const log = baseLog.child({ category: "replay" });

const maxEventsPerSession = 500_000;

/**
 * Byte budget per session, tracked alongside the event count.
 *
 * The count alone is a poor proxy for memory: rrweb envelopes range from tens of
 * bytes for a mouse move to hundreds of kilobytes for a canvas or a large DOM
 * mutation, so 500k events could mean 50MB or several gigabytes. A canvas-heavy
 * single-page app was the realistic way to exhaust the process.
 */
const maxBytesPerSession = 32 * 1024 * 1024;

/**
 * Size at which a session's tail is flushed early, without waiting for the time window.
 *
 * The tail is the one part of a recording that is not durable — it lives in this process
 * until `chunkFlushMs` elapses, and an ungraceful termination loses it. The time window is
 * 30s by default because one S3 object per ingest batch would be thirty times the objects
 * and thirty times the sequence lookups, so shortening it is not free. Bounding it by
 * *size* is: a session generating enough data to matter flushes on volume long before the
 * timer, and a quiet one is not holding anything worth protecting.
 *
 * It also keeps the hard caps above out of reach in normal operation. Those caps *drop*
 * events; before this, a burst could reach 32MB inside a single window and start
 * discarding a live recording.
 */
const flushAtBytes = 4 * 1024 * 1024;
const flushAtEvents = 20_000;

/** Rough retained size of an envelope. JSON length is close enough and cheap. */
function approximateBytes(ev: Record<string, unknown>): number {
  try {
    return JSON.stringify(ev).length;
  } catch {
    // Circular or otherwise unserializable: charge a nominal cost rather than
    // letting it in for free.
    return 1024;
  }
}

/** Drop idle empty sessions so the spool map cannot grow forever after visitors leave. */
const DEFAULT_IDLE_PURGE_MS = 45 * 60 * 1000;

/**
 * The unflushed tail of one session, plus where storage had got to when it was read.
 *
 * `flushedThrough` is the next sequence this process would write. The detail endpoint
 * compares it against the highest chunk it listed to notice a flush that landed after
 * the listing — the one case where the tail it is holding is already in object storage.
 */
export type WarmTail = {
  events: Record<string, unknown>[];
  flushedThrough: number | null;
};

type SessionState = {
  websiteId: string;
  sessionId: string;
  events: Record<string, unknown>[];
  dirty: boolean;
  finalizing: boolean;
  /** Wall time when the current buffered window opened (first event since last flush). */
  chunkWindowStart: number | null;
  /** Next S3 chunk index; null until resolved from storage on first flush. */
  nextChunkSeq: number | null;
  /** Updated on ingest and flush; used to prune sessions with empty buffers after visitors leave. */
  lastTouchedMs: number;
  /** Serializes flushes per session — two concurrent flushes would reuse the same chunk sequence and overwrite each other in S3. */
  inflight: Promise<void> | null;
  /** Approximate retained bytes of `events`; reset whenever the tail is flushed. */
  approxBytes: number;
};

function mapKey(websiteId: string, sessionId: string): string {
  return `${websiteId}\0${sessionId}`;
}

function sortEvents(events: Record<string, unknown>[]): void {
  events.sort(compareReplayEnvelopeEvents);
}

/**
 * In-memory tail buffer: flush every `chunkFlushMs` into an immutable S3 chunk,
 * then clear the buffer (no read-merge bundle).
 */
export class SessionChunkBuffer {
  private sessions = new Map<string, SessionState>();
  private chunkFlushMs: number;
  private idlePurgeMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onChunkFlush: (
    websiteId: string,
    sessionId: string,
    sequence: number,
    events: Record<string, unknown>[],
  ) => Promise<void>;
  private getInitialSequence: (websiteId: string, sessionId: string) => Promise<number>;

  constructor(opts: {
    chunkFlushMs: number;
    /** How long an empty session may sit before it is dropped. Defaults to 45 minutes. */
    idlePurgeMs?: number;
    getInitialSequence: (websiteId: string, sessionId: string) => Promise<number>;
    onChunkFlush: (
      websiteId: string,
      sessionId: string,
      sequence: number,
      events: Record<string, unknown>[],
    ) => Promise<void>;
  }) {
    this.chunkFlushMs = Math.max(5_000, opts.chunkFlushMs);
    // Never below the flush window: purging a session that has not had a chance to flush
    // would throw away its `nextChunkSeq` and re-cold-start the sequence from a listing.
    this.idlePurgeMs = Math.max(this.chunkFlushMs, opts.idlePurgeMs ?? DEFAULT_IDLE_PURGE_MS);
    this.getInitialSequence = opts.getInitialSequence;
    this.onChunkFlush = opts.onChunkFlush;
  }

  start(): void {
    if (this.timer) return;
    const interval = Math.max(5_000, Math.min(this.chunkFlushMs / 2, 15_000));
    this.timer = setInterval(() => void this.tick(), interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flushAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    await Promise.all(keys.map(async (k) => {
      const st = this.sessions.get(k);
      if (!st || st.events.length === 0) return;
      await this.flushChunk(st);
    }));
  }

  push(websiteId: string, sessionId: string, events: Record<string, unknown>[]): void {
    if (!websiteId || !sessionId || events.length === 0) return;
    const k = mapKey(websiteId, sessionId);
    let st = this.sessions.get(k);
    if (!st) {
      const now = Date.now();
      st = {
        websiteId,
        sessionId,
        events: [],
        dirty: false,
        finalizing: false,
        chunkWindowStart: null,
        nextChunkSeq: null,
        lastTouchedMs: now,
        inflight: null,
        approxBytes: 0,
      };
      this.sessions.set(k, st);
    }
    if (st.approxBytes >= maxBytesPerSession) {
      // Touched even though nothing was kept: the visitor is demonstrably still active,
      // and letting the idle sweep collect the row would drop `nextChunkSeq` with it.
      st.lastTouchedMs = Date.now();
      log.warn({
        msg: "replay_spool_byte_overflow_drop",
        session_id: sessionId,
        dropped: events.length,
        approx_bytes: st.approxBytes,
      });
      return;
    }

    const room = maxEventsPerSession - st.events.length;
    if (room <= 0) {
      st.lastTouchedMs = Date.now();
      log.warn({ msg: "replay_spool_overflow_drop", session_id: sessionId, dropped: events.length });
      return;
    }
    if (events.length > room) {
      log.warn({ msg: "replay_spool_overflow_truncate", session_id: sessionId, kept: room, dropped: events.length - room });
      events = events.slice(0, room);
    }
    const wasEmpty = st.events.length === 0;
    Array.prototype.push.apply(st.events, events);
    for (const ev of events) st.approxBytes += approximateBytes(ev);
    st.lastTouchedMs = Date.now();
    if (wasEmpty) {
      st.chunkWindowStart = Date.now();
    }
    st.dirty = true;

    // Detached, like the timer's own flush: `push` is called from the ingest worker's
    // apply path, which must not wait on S3. `flushChunk` chains per session, so this
    // cannot race the tick into reusing a chunk sequence.
    if (st.approxBytes >= flushAtBytes || st.events.length >= flushAtEvents) {
      void this.flushChunk(st).catch((e: unknown) => {
        // The failed batch is already restored to `st.events` by `doFlushChunk`, so the
        // next tick retries it. Logged here only because nothing else awaits this call.
        log.warn({ msg: "replay_spool_size_flush_failed", session_id: st.sessionId, err: String(e) });
      });
    }
  }

  /** Unflushed tail only; detail API assigns sequence using max S3 chunk index + 1. */
  warmChunks(websiteId: string, sessionId: string): WarmTail | null {
    const st = this.sessions.get(mapKey(websiteId, sessionId));
    if (!st) return null;
    if (st.dirty) {
      sortEvents(st.events);
      st.dirty = false;
    }
    if (st.events.length === 0) return null;
    // Copied rather than handed out: the caller reads it asynchronously and a concurrent
    // flush replaces `st.events` wholesale, so the reference would go stale mid-read.
    return { events: [...st.events], flushedThrough: st.nextChunkSeq };
  }

  remove(websiteId: string, sessionId: string): void {
    this.sessions.delete(mapKey(websiteId, sessionId));
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [key, st] of [...this.sessions.entries()]) {
      if (
        st.events.length === 0 &&
        !st.finalizing &&
        now - st.lastTouchedMs > this.idlePurgeMs
      ) {
        this.sessions.delete(key);
      }
    }
    const toFlush: SessionState[] = [];
    for (const st of this.sessions.values()) {
      if (st.finalizing || st.events.length === 0) continue;
      if (st.chunkWindowStart == null) {
        st.chunkWindowStart = now;
      }
      if (now - st.chunkWindowStart < this.chunkFlushMs) continue;
      toFlush.push(st);
    }
    await Promise.all(toFlush.map((st) => this.flushChunk(st)));
  }

  /**
   * Chain flushes per session: `flushAll()` (shutdown) can race an in-flight tick
   * flush; running both concurrently would consume the same `nextChunkSeq` and the
   * second S3 put would overwrite the first chunk.
   */
  private flushChunk(st: SessionState): Promise<void> {
    const prev = st.inflight ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.doFlushChunk(st));
    st.inflight = next.catch(() => {});
    return next;
  }

  private async doFlushChunk(st: SessionState): Promise<void> {
    if (st.events.length === 0) return;
    st.finalizing = true;
    const batch = st.events;
    const batchBytes = st.approxBytes;
    st.events = [];
    st.approxBytes = 0;
    st.dirty = false;
    st.chunkWindowStart = null;
    try {
      if (st.nextChunkSeq === null) {
        st.nextChunkSeq = await this.getInitialSequence(st.websiteId, st.sessionId);
      }
      const seq = st.nextChunkSeq;
      sortEvents(batch);
      await this.onChunkFlush(st.websiteId, st.sessionId, seq, batch);
      st.nextChunkSeq = seq + 1;
      st.lastTouchedMs = Date.now();
    } catch (e) {
      // Restore events so the next tick can retry rather than silently dropping them —
      // and restore their byte cost with them. Leaving `approxBytes` at zero here meant
      // one failed flush permanently un-enforced the memory cap for that session.
      st.events = [...batch, ...st.events];
      st.approxBytes = batchBytes + st.approxBytes;
      st.dirty = true;
      st.chunkWindowStart = Date.now();
      throw e;
    } finally {
      st.finalizing = false;
    }
    /**
     * Keep the session row even when the buffer is empty so `nextChunkSeq` survives until the next
     * ~60s window. Deleting here forced a cold `getInitialSequence()` S3 list on the next batch;
     * listing can briefly miss the chunk just written and return 0 → **overwrite chunk-0** and break
     * replays longer than one flush interval.
     */
  }
}
