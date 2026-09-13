import { describe, expect, it } from "bun:test";
import { compareReplayEnvelopeEvents } from "../services/replay-event-ordering.service";
import { clampListParams, timestampToIso } from "../services/recording-query-normalization.service";

/**
 * Replay event ordering, and the two list helpers.
 *
 * `compareReplayEnvelopeEvents` decides playback order, and it is used in two places
 * that both matter: the engine sorts a batch before spooling it, and
 * `getReplaySessionDetail` sorts the merged legacy stream. rrweb's player assumes
 * monotonically increasing timestamps and degrades silently when they are not —
 * a mis-sort does not throw, it replays the session wrong.
 *
 * The subtlety is that envelope `ts` is *not* the replay timeline. An rrweb envelope
 * carries the real timeline in `data.timestamp`, while `session_error` carries
 * `Date.now()` in `ts`. Sorting on `ts` alone interleaves two different clocks, which is
 * exactly the bug this comparator exists to avoid — so these tests assert the preference
 * rather than just "it sorts".
 *
 * Pure functions with no imports beyond the module under test, so no stubs and no
 * environment.
 */

/** An rrweb envelope whose inner timeline and outer arrival time disagree. */
function rrweb(dataTimestamp: unknown, ts: unknown = 0): Record<string, unknown> {
  return { type: "rrweb", ts, data: { timestamp: dataTimestamp } };
}

function envelope(type: string, ts: unknown): Record<string, unknown> {
  return { type, ts };
}

/** Sorts a copy, so a test can assert on order without mutating its own fixture. */
function sorted(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...events].sort(compareReplayEnvelopeEvents);
}

describe("compareReplayEnvelopeEvents", () => {
  describe("which clock it reads", () => {
    it("prefers an rrweb event's inner timestamp over its envelope ts", () => {
      // The whole point. Envelope `ts` says B is first; the replay timeline says A is.
      const a = rrweb(1000, 9999);
      const b = rrweb(2000, 1);

      expect(sorted([b, a])).toEqual([a, b]);
    });

    it("parses a numeric-string inner timestamp", () => {
      const a = rrweb("1000");
      const b = rrweb("2000");

      expect(sorted([b, a])).toEqual([a, b]);
    });

    it("falls back to the envelope ts for a non-numeric inner timestamp", () => {
      const a = rrweb("not-a-number", 1000);
      const b = rrweb("not-a-number", 2000);

      expect(sorted([b, a])).toEqual([a, b]);
    });

    it("falls back to the envelope ts when the inner timestamp is absent", () => {
      const a = { type: "rrweb", ts: 1000, data: {} };
      const b = { type: "rrweb", ts: 2000, data: {} };

      expect(sorted([b, a])).toEqual([a, b]);
    });

    it("falls back when data is not an object", () => {
      const a = { type: "rrweb", ts: 1000, data: "oops" };
      const b = { type: "rrweb", ts: 2000, data: "oops" };

      expect(sorted([b, a])).toEqual([a, b]);
    });

    it("falls back when data is an array", () => {
      // An array is `typeof "object"`, so the guard checks for it explicitly.
      const a = { type: "rrweb", ts: 1000, data: [1, 2] };
      const b = { type: "rrweb", ts: 2000, data: [1, 2] };

      expect(sorted([b, a])).toEqual([a, b]);
    });

    it("falls back for a non-finite inner timestamp", () => {
      const a = { type: "rrweb", ts: 1000, data: { timestamp: Number.NaN } };
      const b = { type: "rrweb", ts: 2000, data: { timestamp: Number.NaN } };

      expect(sorted([b, a])).toEqual([a, b]);
    });

    it("uses the envelope ts for a non-rrweb event", () => {
      // `session_error` and friends have no inner timeline.
      const a = envelope("session_error", 1000);
      const b = envelope("session_error", 2000);

      expect(sorted([b, a])).toEqual([a, b]);
    });

    it("parses a numeric-string envelope ts", () => {
      const a = envelope("console_event", "1000");
      const b = envelope("console_event", "2000");

      expect(sorted([b, a])).toEqual([a, b]);
    });

    it("treats an unusable timestamp as zero rather than NaN", () => {
      // A NaN comparator return breaks the sort into an arbitrary order. Zero puts the
      // event first, which is at least deterministic.
      const broken = envelope("console_event", undefined);
      const later = envelope("console_event", 1000);

      expect(sorted([later, broken])).toEqual([broken, later]);
    });

    it("orders an rrweb event against a session_error on the same clock value", () => {
      // The mixed case that motivates the whole function: the error's `ts` and the
      // rrweb event's `data.timestamp` are compared against each other.
      const domMutation = rrweb(5000, 1);
      const error = envelope("session_error", 4000);

      expect(sorted([domMutation, error])).toEqual([error, domMutation]);
    });
  });

  describe("the tie-break by kind", () => {
    it("puts rrweb before a console event at the same time", () => {
      // DOM first, so the frame the log refers to already exists when it is shown.
      const dom = rrweb(1000);
      const log = envelope("console_event", 1000);

      expect(sorted([log, dom])).toEqual([dom, log]);
    });

    it("puts a console event before a session error at the same time", () => {
      const log = envelope("console_event", 1000);
      const error = envelope("session_error", 1000);

      expect(sorted([error, log])).toEqual([log, error]);
    });

    it("ranks a network event alongside a console event", () => {
      // Both are kind 1, so their relative order is left as it was.
      const net = envelope("network_event", 1000);
      const log = envelope("console_event", 1000);

      expect(compareReplayEnvelopeEvents(net, log)).toBe(0);
    });

    it("puts an unknown type last at the same time", () => {
      const dom = rrweb(1000);
      const unknown = envelope("something_new", 1000);

      expect(sorted([unknown, dom])).toEqual([dom, unknown]);
    });

    it("orders the full kind sequence at one timestamp", () => {
      const dom = rrweb(1000);
      const log = envelope("console_event", 1000);
      const error = envelope("session_error", 1000);
      const unknown = envelope("mystery", 1000);

      expect(sorted([unknown, error, log, dom])).toEqual([dom, log, error, unknown]);
    });

    it("lets time win over kind", () => {
      // An error at 1000 comes before a DOM mutation at 2000, even though DOM sorts
      // first within a timestamp.
      const error = envelope("session_error", 1000);
      const dom = rrweb(2000);

      expect(sorted([dom, error])).toEqual([error, dom]);
    });
  });

  describe("as a sort comparator", () => {
    it("reports equality for two identical envelopes", () => {
      const a = rrweb(1000);
      const b = rrweb(1000);

      expect(compareReplayEnvelopeEvents(a, b)).toBe(0);
    });

    it("is antisymmetric", () => {
      const a = rrweb(1000);
      const b = rrweb(2000);

      expect(Math.sign(compareReplayEnvelopeEvents(a, b))).toBe(
        -Math.sign(compareReplayEnvelopeEvents(b, a)),
      );
    });

    it("is stable for events it considers equal", () => {
      // Same time, same kind — the original order has to survive, or two console lines
      // logged in one tick can swap.
      const first = { ...envelope("console_event", 1000), id: "first" };
      const second = { ...envelope("console_event", 1000), id: "second" };

      expect(sorted([first, second]).map((e) => e.id)).toEqual(["first", "second"]);
    });

    it("orders a realistic mixed batch", () => {
      const events = [
        envelope("session_error", 2500),
        rrweb(3000, 1),
        rrweb(1000, 2),
        envelope("network_event", 1500),
        rrweb(2000, 3),
      ];

      const order = sorted(events).map((e) =>
        e.type === "rrweb" ? (e.data as { timestamp: number }).timestamp : e.ts,
      );

      expect(order).toEqual([1000, 1500, 2000, 2500, 3000]);
    });

    it("handles an empty batch", () => {
      expect(sorted([])).toEqual([]);
    });

    it("never returns NaN, whatever it is given", () => {
      // A NaN return makes `Array.sort` behaviour undefined, so playback order becomes
      // arbitrary rather than wrong in a predictable way.
      const hostile: Record<string, unknown>[] = [
        {},
        { type: "rrweb" },
        { type: "rrweb", data: null },
        { type: "rrweb", data: { timestamp: {} } },
        { ts: {} },
        { type: 42, ts: "abc" },
      ];

      for (const a of hostile) {
        for (const b of hostile) {
          expect(Number.isNaN(compareReplayEnvelopeEvents(a, b))).toBe(false);
        }
      }
    });
  });
});

describe("timestampToIso", () => {
  it("renders a Date as ISO", () => {
    expect(timestampToIso(new Date("2026-09-01T12:00:00.000Z"))).toBe("2026-09-01T12:00:00.000Z");
  });

  it("renders a date string as ISO", () => {
    // The `postgres` driver returns timestamps as strings for some queries and `Date`
    // for others, and the wire contract is ISO either way.
    expect(timestampToIso("2026-09-01T12:00:00.000Z")).toBe("2026-09-01T12:00:00.000Z");
  });

  it("renders an epoch number as ISO", () => {
    expect(timestampToIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("falls back to the epoch for an invalid Date", () => {
    expect(timestampToIso(new Date("nonsense"))).toBe("1970-01-01T00:00:00.000Z");
  });

  it("falls back to the epoch for an unparseable string", () => {
    // A throw here would fail the whole list response over one bad row.
    expect(timestampToIso("not a date")).toBe("1970-01-01T00:00:00.000Z");
  });

  it("falls back to the epoch for null", () => {
    expect(timestampToIso(null)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("falls back to the epoch for undefined", () => {
    expect(timestampToIso(undefined)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("always returns a parseable ISO string", () => {
    const inputs = [new Date(), "2026-01-01", 1_767_225_600_000, "", null, undefined, {}, NaN];

    for (const v of inputs) {
      expect(Number.isNaN(Date.parse(timestampToIso(v)))).toBe(false);
    }
  });
});

describe("clampListParams", () => {
  it("passes plausible values through", () => {
    expect(clampListParams(50, 100)).toEqual({ limit: 50, offset: 100 });
  });

  it("defaults a limit below one to twenty", () => {
    expect(clampListParams(0, 0).limit).toBe(20);
    expect(clampListParams(-5, 0).limit).toBe(20);
  });

  it("defaults a non-finite limit", () => {
    expect(clampListParams(Number.NaN, 0).limit).toBe(20);
    expect(clampListParams(Number.POSITIVE_INFINITY, 0).limit).toBe(20);
  });

  it("caps the limit at five hundred", () => {
    // The ceiling is what stops one request from selecting the whole table.
    expect(clampListParams(10_000, 0).limit).toBe(500);
  });

  it("allows a limit exactly at the cap", () => {
    expect(clampListParams(500, 0).limit).toBe(500);
  });

  it("allows a limit of one", () => {
    expect(clampListParams(1, 0).limit).toBe(1);
  });

  it("floors a negative offset at zero", () => {
    expect(clampListParams(20, -10).offset).toBe(0);
  });

  it("defaults a non-finite offset to zero", () => {
    expect(clampListParams(20, Number.NaN).offset).toBe(0);
  });

  it("leaves a large offset alone", () => {
    // Only the limit is capped: paging deep into a filtered set is legitimate.
    expect(clampListParams(20, 1_000_000).offset).toBe(1_000_000);
  });

  it("never returns a value that would break a SQL LIMIT/OFFSET", () => {
    const inputs: [number, number][] = [
      [0, 0],
      [-1, -1],
      [Number.NaN, Number.NaN],
      [Infinity, Infinity],
      [1e9, 1e9],
      [1.5, 2.5],
    ];

    for (const [limit, offset] of inputs) {
      const out = clampListParams(limit, offset);

      expect(Number.isFinite(out.limit)).toBe(true);
      expect(Number.isFinite(out.offset)).toBe(true);
      expect(out.limit).toBeGreaterThanOrEqual(1);
      expect(out.limit).toBeLessThanOrEqual(500);
      expect(out.offset).toBeGreaterThanOrEqual(0);
    }
  });
});
