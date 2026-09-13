import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SessionMetaRow } from "../interfaces";

/**
 * The player's read path — `getReplaySessionDetail`.
 *
 * 244 lines with no tests, and the single most consequential function in the module:
 * everything the replay player draws comes through it. Four things here are behaviour
 * that no type can hold, and each is a way for playback to break rather than fail:
 *
 * 1. **Four storage shapes, one endpoint.** Chunked (the current form), a legacy inline
 *    bundle, a presigned bundle, and "pending". The `replay_storage` discriminator is
 *    what the client switches on, so returning the wrong one plays nothing while
 *    reporting success.
 * 2. **The warm tail must not overlap the stored chunks.** The in-memory buffer is read
 *    *after* the object listing on purpose. Reversed, a flush landing between the two
 *    hands the same events back twice — once listed, once as `warm_chunks` — and the
 *    player appends the tail through rrweb's live-mode `addEvent`, which assumes
 *    increasing timestamps.
 * 3. **A flush between the listing and the tail read leaves a gap.** `flushedThrough`
 *    is compared against the highest listed sequence, and one re-list closes it. Without
 *    that check the response omits a chunk that exists, which is a hole in the middle
 *    of playback.
 * 4. **A missing recording is a 404 only when there is no metadata either.** With
 *    metadata it is "pending" — the recording is still being written — and the player
 *    shows a waiting state instead of an error.
 *
 * The shared stubs (`support/stubs.ts`) supply s3, config and the logger. This file adds
 * the repository and the engine, both complete — see `app/tests/mock-completeness.test.ts`.
 */

// Registers the shared infrastructure stubs. Must come before the modules under test.
import { resetStubs, storedChunks } from "./support/stubs";

/** Meta row `getSessionMeta` should report, or null for a session with no metadata. */
let metaRow: SessionMetaRow | null = null;
/** Session ids passed to `deleteSession`, in order. */
const deletedSessions: { websiteId: string; sessionId: string }[] = [];

mock.module("../repositories/recording.repository", () => ({
  upsertSessionMetaBatch: async () => 0,
  listSessions: async () => [],
  summarizeSessions: async () => ({
    total: 0,
    withErrors: 0,
    withRageClicks: 0,
    avgDurationSeconds: 0,
  }),
  getSessionMeta: async () => metaRow,
  deleteSession: async (websiteId: string, sessionId: string) => {
    deletedSessions.push({ websiteId, sessionId });
  },
}));

/** What `engine.warmChunks` should report for the session under test. */
let warmTail: { events: Record<string, unknown>[]; flushedThrough: number | null } | null = null;
/** Sessions whose spool was removed, in order. */
const removedSpools: string[] = [];
/**
 * Runs on each `warmChunks` call, so a test can simulate a flush landing between the
 * object listing and the tail read.
 */
let onWarmChunks: (() => void) | null = null;

mock.module("../services/recording-ingest.service", () => ({
  recordingIngestService: () => ({
    warmChunks: () => {
      onWarmChunks?.();
      return warmTail;
    },
    removeSpool: (_websiteId: string, sessionId: string) => {
      removedSpools.push(sessionId);
    },
    processEvents: async () => {},
    shutdown: async () => {},
    flushNow: async () => {},
  }),
  RecordingIngestService: class {},
  // Not driven here, but a global stub has to list every runtime export or an
  // unrelated file fails on the missing name — see `app/tests/mock-completeness.test.ts`.
  stopRecordingIngestService: async () => {},
}));

const { getReplaySessionDetail } = await import("../services/session-detail.service");
const { batchDeleteReplaySessions } = await import("../services/session-delete.service");

const WEBSITE = "11111111-1111-4111-8111-111111111111";
const SESSION = "sess_1";

function meta(over: Partial<SessionMetaRow> = {}): SessionMetaRow {
  return {
    sessionId: SESSION,
    websiteId: WEBSITE,
    browser: "Chrome",
    device: "Desktop",
    os: "macOS",
    country: "BD",
    entryPage: "https://shop.test/",
    startedAt: new Date("2026-09-01T00:00:00.000Z"),
    hasRageClicks: false,
    hasErrors: false,
    durationSeconds: 12,
    pagesViewed: 2,
    ...over,
  } as SessionMetaRow;
}

/** An rrweb envelope, ordered by its inner `data.timestamp`. */
function rrweb(timestamp: number): Record<string, unknown> {
  return { type: "rrweb", ts: timestamp, data: { timestamp } };
}

beforeEach(() => {
  resetStubs();
  metaRow = null;
  warmTail = null;
  onWarmChunks = null;
  deletedSessions.length = 0;
  removedSpools.length = 0;
});

describe("chunked storage", () => {
  it("reports the chunk shape when objects exist", () => {
    storedChunks.set(SESSION, [
      { sequence: 0, key: "k0" },
      { sequence: 1, key: "k1" },
    ]);

    return getReplaySessionDetail(WEBSITE, SESSION).then((out) => {
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({
        replay_storage: "chunks",
        replay_chunk_count: 2,
        recording_pending: false,
      });
    });
  });

  it("presigns every chunk", async () => {
    storedChunks.set(SESSION, [
      { sequence: 0, key: "k0" },
      { sequence: 1, key: "k1" },
    ]);

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    const urls = (out.body as { replay_chunk_urls: { sequence: number; url: string }[] })
      .replay_chunk_urls;
    expect(urls.map((u) => u.sequence)).toEqual([0, 1]);
    expect(urls[0]!.url).toBe("https://signed.test/k0");
  });

  it("orders chunks by sequence, not by listing order", () => {
    // Playback concatenates them in the order given, so a shuffled listing plays the
    // session out of order.
    storedChunks.set(SESSION, [
      { sequence: 2, key: "k2" },
      { sequence: 0, key: "k0" },
      { sequence: 1, key: "k1" },
    ]);

    return getReplaySessionDetail(WEBSITE, SESSION).then((out) => {
      const urls = (out.body as { replay_chunk_urls: { sequence: number }[] }).replay_chunk_urls;
      expect(urls.map((u) => u.sequence)).toEqual([0, 1, 2]);
    });
  });

  it("collapses a duplicate sequence to one chunk", async () => {
    // A redelivered upload can leave two objects at the same sequence. Handing both to
    // the player replays that window twice.
    storedChunks.set(SESSION, [
      { sequence: 0, key: "k0-first" },
      { sequence: 0, key: "k0-again" },
      { sequence: 1, key: "k1" },
    ]);

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as { replay_chunk_count: number }).replay_chunk_count).toBe(2);
  });

  it("keeps the first key for a duplicated sequence", async () => {
    storedChunks.set(SESSION, [
      { sequence: 0, key: "k0-first" },
      { sequence: 0, key: "k0-again" },
    ]);

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    const urls = (out.body as { replay_chunk_urls: { url: string }[] }).replay_chunk_urls;
    expect(urls[0]!.url).toBe("https://signed.test/k0-first");
  });

  it("states when the presigned urls expire", async () => {
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    const urls = (out.body as { replay_chunk_urls: { expires_at: string }[] }).replay_chunk_urls;
    expect(Date.parse(urls[0]!.expires_at)).toBeGreaterThan(Date.now());
  });

  it("omits warm_chunks when the buffer is empty", async () => {
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);
    warmTail = { events: [], flushedThrough: 1 };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect("warm_chunks" in out.body).toBe(false);
  });

  it("appends the warm tail at one past the highest stored sequence", async () => {
    // The player treats `sequence` as playback order, so the tail has to sort after
    // every stored chunk.
    storedChunks.set(SESSION, [
      { sequence: 0, key: "k0" },
      { sequence: 1, key: "k1" },
    ]);
    warmTail = { events: [rrweb(1000)], flushedThrough: 2 };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    const warm = (out.body as { warm_chunks: { sequence: number }[] }).warm_chunks;
    expect(warm[0]!.sequence).toBe(2);
  });

  it("carries the buffered events in the warm chunk", async () => {
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);
    warmTail = { events: [rrweb(1000), rrweb(2000)], flushedThrough: 1 };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    const warm = (out.body as { warm_chunks: { data: unknown[] }[] }).warm_chunks;
    expect(warm[0]!.data).toHaveLength(2);
  });
});

describe("the re-list guard", () => {
  it("re-lists when a flush landed after the listing", async () => {
    // The gap case. The first listing sees sequence 0; a flush then writes 1 and 2, so
    // `flushedThrough` (3) is more than one past the highest listed sequence (0). One
    // re-list closes the hole; without it the response never mentions 1 and 2 and
    // playback jumps.
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);
    warmTail = { events: [], flushedThrough: 3 };

    onWarmChunks = () => {
      storedChunks.set(SESSION, [
        { sequence: 0, key: "k0" },
        { sequence: 1, key: "k1" },
        { sequence: 2, key: "k2" },
      ]);
    };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as { replay_chunk_count: number }).replay_chunk_count).toBe(3);
  });

  it("does not re-list when the listing is already current", async () => {
    // `flushedThrough` one past the highest listed sequence is the normal state: the
    // spool has written everything the listing saw and nothing more.
    storedChunks.set(SESSION, [
      { sequence: 0, key: "k0" },
      { sequence: 1, key: "k1" },
    ]);
    warmTail = { events: [], flushedThrough: 2 };

    let listingsAfterWarmRead = 0;
    onWarmChunks = () => {
      listingsAfterWarmRead = -1; // marker: the tail was read
      storedChunks.set(SESSION, [
        { sequence: 0, key: "k0" },
        { sequence: 1, key: "k1" },
        { sequence: 2, key: "k2-should-not-appear" },
      ]);
    };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect(listingsAfterWarmRead).toBe(-1);
    expect((out.body as { replay_chunk_count: number }).replay_chunk_count).toBe(2);
  });

  it("does not re-list when the spool has never flushed", async () => {
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);
    warmTail = { events: [rrweb(1)], flushedThrough: null };

    onWarmChunks = () => {
      storedChunks.set(SESSION, [
        { sequence: 0, key: "k0" },
        { sequence: 1, key: "k1-should-not-appear" },
      ]);
    };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as { replay_chunk_count: number }).replay_chunk_count).toBe(1);
  });

  it("re-lists for a session whose first flush happened after an empty listing", async () => {
    // Highest listed is -1 when nothing is stored, so `flushedThrough > 0` triggers it.
    storedChunks.set(SESSION, []);
    warmTail = { events: [], flushedThrough: 2 };

    onWarmChunks = () => {
      storedChunks.set(SESSION, [
        { sequence: 0, key: "k0" },
        { sequence: 1, key: "k1" },
      ]);
    };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect(out.body).toMatchObject({ replay_storage: "chunks", replay_chunk_count: 2 });
  });

  it("reads the tail after the listing, so the two cannot overlap", async () => {
    // The ordering that makes the whole thing safe: anything already flushed is out of
    // the buffer by the time the tail is read, so a listed chunk cannot also appear as
    // a warm event.
    const order: string[] = [];
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);
    warmTail = { events: [rrweb(1)], flushedThrough: 1 };

    onWarmChunks = () => order.push("tail");
    const originalGet = storedChunks.get.bind(storedChunks);
    storedChunks.get = ((id: string) => {
      order.push("listing");
      return originalGet(id);
    }) as typeof storedChunks.get;

    try {
      await getReplaySessionDetail(WEBSITE, SESSION);
    } finally {
      storedChunks.get = originalGet;
    }

    expect(order[0]).toBe("listing");
    expect(order).toContain("tail");
    expect(order.indexOf("listing")).toBeLessThan(order.indexOf("tail"));
  });
});

describe("the legacy inline bundle", () => {
  it("merges the stored bundle with the warm tail", async () => {
    // No chunks, but a bundle and a live buffer — a session that started before
    // chunked storage and is still recording.
    warmTail = { events: [rrweb(3000)], flushedThrough: null };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect(out.body).toMatchObject({ replay_storage: "legacy_inline", recording_pending: false });
  });

  it("returns the merged stream as a single chunk at sequence 0", async () => {
    warmTail = { events: [rrweb(3000), rrweb(1000)], flushedThrough: null };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    const warm = (out.body as { warm_chunks: { sequence: number; data: unknown[] }[] })
      .warm_chunks;
    expect(warm).toHaveLength(1);
    expect(warm[0]!.sequence).toBe(0);
  });

  it("sorts the merged stream by the replay timeline", async () => {
    // rrweb's player assumes increasing timestamps. Arrival order is not that order —
    // a `session_error` carries `Date.now()` while rrweb events carry relative time.
    warmTail = {
      events: [rrweb(3000), rrweb(1000), rrweb(2000)],
      flushedThrough: null,
    };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    const data = (out.body as { warm_chunks: { data: Record<string, unknown>[] }[] })
      .warm_chunks[0]!.data;
    expect(data.map((e) => (e.data as { timestamp: number }).timestamp)).toEqual([
      1000, 2000, 3000,
    ]);
  });

  it("prefers the chunk shape when both chunks and a warm tail exist", async () => {
    // Chunks are checked first, so a session that has both must not be reported as
    // legacy — the player would fetch a bundle that is not the authoritative copy.
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);
    warmTail = { events: [rrweb(1)], flushedThrough: 1 };

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as { replay_storage: string }).replay_storage).toBe("chunks");
  });
});

describe("pending and missing recordings", () => {
  it("answers 404 when there is neither a recording nor metadata", async () => {
    const out = await getReplaySessionDetail(WEBSITE, "nope");

    expect(out.status).toBe(404);
    expect((out.body as { error: string }).error).toContain("not available yet");
  });

  it("reports pending when metadata exists but no recording does", async () => {
    // The recording is still being written. A 404 here would show the user an error
    // for a session that is about to work.
    metaRow = meta();

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ replay_storage: "pending", recording_pending: true });
  });

  it("carries the metadata on a pending response", async () => {
    // The player renders the header from it while waiting.
    metaRow = meta({ browser: "Firefox" });

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as { meta: { browser: string } }).meta.browser).toBe("Firefox");
  });

  it("does not report pending once chunks exist", async () => {
    metaRow = meta();
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as { recording_pending: boolean }).recording_pending).toBe(false);
  });
});

describe("metadata projection", () => {
  it("carries every header field through", async () => {
    metaRow = meta();
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as { meta: Record<string, unknown> }).meta).toMatchObject({
      sessionId: SESSION,
      browser: "Chrome",
      device: "Desktop",
      os: "macOS",
      country: "BD",
      durationSeconds: 12,
      pagesViewed: 2,
    });
  });

  it("renders startedAt as an ISO string", async () => {
    // The driver hands timestamps back as `Date` or as a string depending on the
    // query; the wire contract is ISO either way.
    metaRow = meta({ startedAt: new Date("2026-09-01T12:34:56.000Z") });
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as { meta: { startedAt: string } }).meta.startedAt).toBe(
      "2026-09-01T12:34:56.000Z",
    );
  });

  it("renders a string timestamp as ISO too", async () => {
    metaRow = meta({ startedAt: "2026-09-01T12:34:56.000Z" as unknown as Date });
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as { meta: { startedAt: string } }).meta.startedAt).toBe(
      "2026-09-01T12:34:56.000Z",
    );
  });

  it("reports null metadata rather than omitting the field", async () => {
    // The client reads `meta` unconditionally; omitting it is a different shape from
    // reporting it absent.
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as { meta: unknown }).meta).toBeNull();
  });

  it("carries the rage-click and error flags", async () => {
    metaRow = meta({ hasRageClicks: true, hasErrors: true });
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);

    const out = await getReplaySessionDetail(WEBSITE, SESSION);

    expect((out.body as unknown as { meta: Record<string, boolean> }).meta).toMatchObject({
      hasRageClicks: true,
      hasErrors: true,
    });
  });
});

describe("the session id", () => {
  it("trims surrounding whitespace before looking anything up", async () => {
    storedChunks.set(SESSION, [{ sequence: 0, key: "k0" }]);

    const out = await getReplaySessionDetail(WEBSITE, `  ${SESSION}  `);

    expect((out.body as { session_id: string }).session_id).toBe(SESSION);
    expect((out.body as { replay_storage: string }).replay_storage).toBe("chunks");
  });

  it("echoes the trimmed id, not the one it was given", async () => {
    metaRow = meta();

    const out = await getReplaySessionDetail(WEBSITE, ` ${SESSION} `);

    expect((out.body as { session_id: string }).session_id).toBe(SESSION);
  });
});

describe("batchDeleteReplaySessions", () => {
  it("removes the in-memory spool before touching storage", async () => {
    // Otherwise a spool flush racing the delete re-creates the objects that were just
    // removed, and the session comes back.
    await batchDeleteReplaySessions(WEBSITE, [SESSION]);

    expect(removedSpools).toEqual([SESSION]);
  });

  it("deletes the database row for every session", async () => {
    await batchDeleteReplaySessions(WEBSITE, ["a", "b", "c"]);

    expect(deletedSessions.map((d) => d.sessionId).sort()).toEqual(["a", "b", "c"]);
  });

  it("scopes the delete to the website", async () => {
    await batchDeleteReplaySessions(WEBSITE, [SESSION]);

    expect(deletedSessions[0]!.websiteId).toBe(WEBSITE);
  });

  it("is a no-op for an empty list", async () => {
    await batchDeleteReplaySessions(WEBSITE, []);

    expect(deletedSessions).toEqual([]);
    expect(removedSpools).toEqual([]);
  });

  it("still deletes the row when object storage fails", async () => {
    // Best-effort across the two stores: an object that is already gone must not leave
    // the row behind, or the session stays listed forever and cannot be re-deleted.
    const { s3DeleteFailures } = await import("./support/stubs");
    s3DeleteFailures.add(SESSION);

    await batchDeleteReplaySessions(WEBSITE, [SESSION]);

    expect(deletedSessions.map((d) => d.sessionId)).toEqual([SESSION]);
  });

  it("deletes the other sessions when one object delete fails", async () => {
    const { s3DeleteFailures } = await import("./support/stubs");
    s3DeleteFailures.add("b");

    await batchDeleteReplaySessions(WEBSITE, ["a", "b", "c"]);

    expect(deletedSessions.map((d) => d.sessionId).sort()).toEqual(["a", "b", "c"]);
  });

  it("removes every spool even when the deletes fail", async () => {
    const { s3DeleteFailures } = await import("./support/stubs");
    s3DeleteFailures.add("a");
    s3DeleteFailures.add("b");

    await batchDeleteReplaySessions(WEBSITE, ["a", "b"]);

    expect(removedSpools.sort()).toEqual(["a", "b"]);
  });
});
