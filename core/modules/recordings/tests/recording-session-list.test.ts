import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SessionListFilters, SessionListSummary } from "../interfaces";

/**
 * The session list, in both of its projections.
 *
 * Two decisions here are the reason the file exists, and both were bugs once:
 *
 * 1. **`summary` is computed over the whole filtered set, not the returned page.** The
 *    dashboard used to fetch a fixed 100 rows and render `rows.length` as "Total
 *    Sessions" — a headline number that silently stopped counting at 100. So the summary
 *    has to come from its own query, and `total` has to come from the summary rather than
 *    from the page.
 * 2. **Filtering is server-side.** A search that only sees the rows already downloaded
 *    reports "no results" for sessions that exist, so the filters must reach the
 *    repository rather than being applied after.
 *
 * There are two shapes: camelCase for the dashboard and snake_case for the raw API. They
 * are separate functions over the same rows, which makes a field that is projected in one
 * and forgotten in the other an easy and invisible mistake — so both are asserted.
 */

// Registers the shared infrastructure stubs. Must come before the modules under test.
import { resetStubs } from "./support/stubs";

/** Rows `listSessions` should report. */
let rows: Record<string, unknown>[] = [];
/** Summary `summarizeSessions` should report. */
let summary: SessionListSummary = {
  total: 0,
  withErrors: 0,
  withRageClicks: 0,
  avgDurationSeconds: 0,
};
/** Every `listSessions` call, in order. */
const listCalls: { websiteId: string; limit: number; offset: number; filters?: SessionListFilters }[] =
  [];
/** Every `summarizeSessions` call, in order. */
const summaryCalls: { websiteId: string; filters?: SessionListFilters }[] = [];

/**
 * Delay applied to `listSessions`, so a test can observe whether the summary query
 * starts before the page query resolves.
 *
 * A knob on the one stub rather than a second `mock.module` call. Re-registering the
 * same specifier mid-file replaces the stub for every test after it — the mock registry
 * is process-global and rebinds live bindings — which silently emptied `listCalls` for
 * the rest of this file.
 */
let listDelayMs = 0;
/** True once `listSessions` has resolved; read by `summarizeSessions`. */
let listResolved = false;
/** Whether the summary query began before the page query finished. */
let summaryOverlappedList = false;

mock.module("../repositories/recording.repository", () => ({
  upsertSessionMetaBatch: async () => 0,
  listSessions: async (
    websiteId: string,
    limit: number,
    offset: number,
    filters?: SessionListFilters,
  ) => {
    listCalls.push({ websiteId, limit, offset, filters });
    if (listDelayMs > 0) await new Promise((r) => setTimeout(r, listDelayMs));
    listResolved = true;
    return rows;
  },
  summarizeSessions: async (websiteId: string, filters?: SessionListFilters) => {
    summaryCalls.push({ websiteId, filters });
    if (!listResolved) summaryOverlappedList = true;
    return summary;
  },
  getSessionMeta: async () => null,
  deleteSession: async () => {},
}));

const { listReplaySessions, listReplaySessionsRaw } = await import(
  "../services/recording-session-list.service"
);

const WEBSITE = "11111111-1111-4111-8111-111111111111";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "sess_1",
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
  };
}

beforeEach(() => {
  resetStubs();
  rows = [row()];
  summary = { total: 137, withErrors: 9, withRageClicks: 4, avgDurationSeconds: 42 };
  listCalls.length = 0;
  summaryCalls.length = 0;
  listDelayMs = 0;
  listResolved = false;
  summaryOverlappedList = false;
});

describe("listReplaySessions", () => {
  describe("totals", () => {
    it("reports the whole-set total, not the page length", () => {
      // The original bug: `rows.length` as "Total Sessions" stopped counting at the
      // page size and made every headline figure a statistic about page one.
      rows = [row(), row()];

      return listReplaySessions(WEBSITE, 20, 0).then((out) => {
        expect(out.sessions).toHaveLength(2);
        expect(out.total).toBe(137);
      });
    });

    it("returns the summary alongside the page", async () => {
      const out = await listReplaySessions(WEBSITE, 20, 0);

      expect(out.summary).toEqual({
        total: 137,
        withErrors: 9,
        withRageClicks: 4,
        avgDurationSeconds: 42,
      });
    });

    it("takes total from the summary, so the two cannot disagree", async () => {
      const out = await listReplaySessions(WEBSITE, 20, 0);

      expect(out.total).toBe(out.summary.total);
    });

    it("reports a zero total for an empty set without failing", async () => {
      rows = [];
      summary = { total: 0, withErrors: 0, withRageClicks: 0, avgDurationSeconds: 0 };

      const out = await listReplaySessions(WEBSITE, 20, 0);

      expect(out).toMatchObject({ sessions: [], total: 0 });
    });

    it("computes the summary over the same filters as the page", async () => {
      // A summary computed unfiltered next to a filtered page reports totals for a
      // different set than the rows on screen.
      const filters: SessionListFilters = { hasErrors: true };

      await listReplaySessions(WEBSITE, 20, 0, filters);

      expect(summaryCalls[0]!.filters).toEqual(filters);
      expect(listCalls[0]!.filters).toEqual(filters);
    });
  });

  describe("paging", () => {
    it("passes the requested window through", async () => {
      await listReplaySessions(WEBSITE, 50, 100);

      expect(listCalls[0]).toMatchObject({ websiteId: WEBSITE, limit: 50, offset: 100 });
    });

    it("echoes the window it actually used", async () => {
      const out = await listReplaySessions(WEBSITE, 50, 100);

      expect(out).toMatchObject({ limit: 50, offset: 100 });
    });

    it("clamps an unbounded limit before querying", async () => {
      await listReplaySessions(WEBSITE, 10_000, 0);

      expect(listCalls[0]!.limit).toBe(500);
    });

    it("echoes the clamped limit, not the requested one", async () => {
      // The client pages against this number; echoing the unclamped value makes it
      // compute the next offset wrong and skip rows.
      const out = await listReplaySessions(WEBSITE, 10_000, 0);

      expect(out.limit).toBe(500);
    });

    it("defaults a nonsense limit", async () => {
      await listReplaySessions(WEBSITE, 0, 0);

      expect(listCalls[0]!.limit).toBe(20);
    });

    it("floors a negative offset", async () => {
      await listReplaySessions(WEBSITE, 20, -10);

      expect(listCalls[0]!.offset).toBe(0);
    });

    it("does not pass the offset to the summary query", async () => {
      // The summary is over the whole set; an offset would make it a statistic about
      // the tail.
      await listReplaySessions(WEBSITE, 20, 100);

      expect(summaryCalls[0]).toEqual({ websiteId: WEBSITE, filters: {} });
    });
  });

  describe("filters", () => {
    it("defaults to no filters rather than undefined", async () => {
      await listReplaySessions(WEBSITE, 20, 0);

      expect(listCalls[0]!.filters).toEqual({});
    });

    it("passes filters to the repository rather than applying them after", async () => {
      const filters: SessionListFilters = { hasRageClicks: true, device: "Mobile" };

      await listReplaySessions(WEBSITE, 20, 0, filters);

      expect(listCalls[0]!.filters).toEqual(filters);
    });

    it("issues the page and summary queries concurrently", async () => {
      // `Promise.all`, not sequential — the list endpoint pays for both on every
      // dashboard load, so running them in series doubles its latency.
      listDelayMs = 10;

      await listReplaySessions(WEBSITE, 20, 0);

      expect(summaryOverlappedList).toBe(true);
    });
  });

  describe("the dashboard projection", () => {
    it("carries every field the player header needs", async () => {
      const out = await listReplaySessions(WEBSITE, 20, 0);

      expect(out.sessions[0]).toEqual({
        sessionId: "sess_1",
        websiteId: WEBSITE,
        browser: "Chrome",
        device: "Desktop",
        os: "macOS",
        country: "BD",
        entryPage: "https://shop.test/",
        startedAt: "2026-09-01T00:00:00.000Z",
        hasRageClicks: false,
        hasErrors: false,
        durationSeconds: 12,
        pagesViewed: 2,
      });
    });

    it("renders startedAt as an ISO string", async () => {
      rows = [row({ startedAt: new Date("2026-09-01T12:34:56.000Z") })];

      const out = await listReplaySessions(WEBSITE, 20, 0);

      expect(out.sessions[0]!.startedAt).toBe("2026-09-01T12:34:56.000Z");
    });

    it("renders a string timestamp as ISO too", async () => {
      // The driver returns either, depending on the query.
      rows = [row({ startedAt: "2026-09-01T12:34:56.000Z" })];

      const out = await listReplaySessions(WEBSITE, 20, 0);

      expect(out.sessions[0]!.startedAt).toBe("2026-09-01T12:34:56.000Z");
    });

    it("does not fail the whole page over one unparseable timestamp", async () => {
      rows = [row({ startedAt: "nonsense" }), row({ sessionId: "sess_2" })];

      const out = await listReplaySessions(WEBSITE, 20, 0);

      expect(out.sessions).toHaveLength(2);
      expect(out.sessions[0]!.startedAt).toBe("1970-01-01T00:00:00.000Z");
    });

    it("carries the flags the list filters on", async () => {
      rows = [row({ hasRageClicks: true, hasErrors: true })];

      const out = await listReplaySessions(WEBSITE, 20, 0);

      expect(out.sessions[0]).toMatchObject({ hasRageClicks: true, hasErrors: true });
    });

    it("preserves row order", async () => {
      // The repository orders newest first; re-mapping must not reorder.
      rows = [row({ sessionId: "a" }), row({ sessionId: "b" }), row({ sessionId: "c" })];

      const out = await listReplaySessions(WEBSITE, 20, 0);

      expect(out.sessions.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
    });
  });
});

describe("listReplaySessionsRaw", () => {
  it("projects to snake_case for the raw API", async () => {
    const out = await listReplaySessionsRaw(WEBSITE, 20, 0);

    expect(out.sessions[0]).toEqual({
      session_id: "sess_1",
      website_id: WEBSITE,
      browser: "Chrome",
      device: "Desktop",
      os: "macOS",
      country: "BD",
      entry_page: "https://shop.test/",
      started_at: "2026-09-01T00:00:00.000Z",
      duration_seconds: 12,
      pages_viewed: 2,
      has_rage_clicks: false,
      has_errors: false,
    });
  });

  it("carries the same fields as the dashboard shape, under snake_case names", async () => {
    // The two projections are written out by hand, so a field added to one and
    // forgotten in the other is invisible. This asserts the pair is complete.
    const camel = await listReplaySessions(WEBSITE, 20, 0);
    const snake = await listReplaySessionsRaw(WEBSITE, 20, 0);

    const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const expected = Object.keys(camel.sessions[0]!).map(toSnake).sort();

    expect(Object.keys(snake.sessions[0]!).sort()).toEqual(expected);
  });

  it("reports the whole-set total", async () => {
    const out = await listReplaySessionsRaw(WEBSITE, 20, 0);

    expect(out.total).toBe(137);
  });

  it("does not expose the summary breakdown", async () => {
    // A data-export surface, not the dashboard's: the derived stats are not part of it.
    const out = await listReplaySessionsRaw(WEBSITE, 20, 0);

    expect("summary" in out).toBe(false);
  });

  it("clamps the window the same way", async () => {
    await listReplaySessionsRaw(WEBSITE, 10_000, -5);

    expect(listCalls[0]).toMatchObject({ limit: 500, offset: 0 });
  });

  it("echoes the clamped window", async () => {
    const out = await listReplaySessionsRaw(WEBSITE, 10_000, -5);

    expect(out).toMatchObject({ limit: 500, offset: 0 });
  });

  it("queries without filters", async () => {
    // The raw surface takes no filter parameters, so it must not invent any.
    await listReplaySessionsRaw(WEBSITE, 20, 0);

    expect(listCalls[0]!.filters).toBeUndefined();
    expect(summaryCalls[0]!.filters).toBeUndefined();
  });

  it("renders timestamps as ISO", async () => {
    rows = [row({ startedAt: new Date("2026-09-01T12:34:56.000Z") })];

    const out = await listReplaySessionsRaw(WEBSITE, 20, 0);

    expect(out.sessions[0]!.started_at).toBe("2026-09-01T12:34:56.000Z");
  });

  it("resolves the website once, from the id it was given", async () => {
    // The raw API's key middleware already resolved the website to authenticate the
    // request; resolving again here was a second lookup for an answer the caller held.
    await listReplaySessionsRaw(WEBSITE, 20, 0);

    expect(listCalls[0]!.websiteId).toBe(WEBSITE);
    expect(summaryCalls[0]!.websiteId).toBe(WEBSITE);
  });
});
