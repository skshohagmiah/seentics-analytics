import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { batchIdFromContent } from "../batch-id";

/**
 * The whole idempotency scheme rests on this function being stable, so these assert the
 * two properties the marker depends on: the same rows always produce the same id, and
 * different rows do not collide.
 *
 * No database here — that is the point of `batch-id.ts` being separate from
 * `apply-once.ts`. The ingest queue imports only this, so its own tests stay
 * connection-free.
 */

function pageview(overrides: Record<string, unknown> = {}) {
  return {
    type: "pageview",
    ts: 1_767_225_600_000,
    sid: "sess_1",
    vid: "vis_1",
    page: "/pricing",
    ...overrides,
  };
}

describe("batchIdFromContent", () => {
  /**
   * The retry case. `flushAnalytics` re-queues the same array and flushes it again, so a
   * differing id would write the batch twice — `analytics_events` has no natural key to
   * conflict on.
   */
  it("is stable for the same rows", () => {
    const rows = [pageview(), pageview({ sid: "sess_2" })];
    expect(batchIdFromContent(rows)).toBe(batchIdFromContent(rows));
    expect(batchIdFromContent([...rows])).toBe(batchIdFromContent(rows));
  });

  /** Stable across processes too, or a redelivery after a restart writes twice. */
  it("depends only on content, not on identity or call order", () => {
    const a = batchIdFromContent([pageview()]);
    const b = batchIdFromContent([{ ...pageview() }]);
    expect(a).toBe(b);
  });

  it("separates batches that differ in any field", () => {
    const base = batchIdFromContent([pageview()]);
    expect(batchIdFromContent([pageview({ sid: "sess_2" })])).not.toBe(base);
    expect(batchIdFromContent([pageview({ ts: 1_767_225_600_001 })])).not.toBe(base);
    expect(batchIdFromContent([pageview({ page: "/about" })])).not.toBe(base);
  });

  it("separates batches that differ in length", () => {
    expect(batchIdFromContent([pageview(), pageview()])).not.toBe(batchIdFromContent([pageview()]));
  });

  /**
   * Order is part of the identity. Two flushes holding the same events in a different
   * order are different batches, and treating them as one would drop the second.
   */
  it("treats a reordered batch as a different batch", () => {
    const a = pageview({ sid: "a" });
    const b = pageview({ sid: "b" });
    expect(batchIdFromContent([a, b])).not.toBe(batchIdFromContent([b, a]));
  });

  it("returns a stable-width hex id", () => {
    expect(batchIdFromContent([pageview()])).toMatch(/^[0-9a-f]{32}$/);
    expect(batchIdFromContent([])).toMatch(/^[0-9a-f]{32}$/);
  });
});

/**
 * The digest is fed row by row rather than as one `JSON.stringify(rows)`, so that a flush
 * carrying fifty thousand events — or a few megabytes per event, for screenshots — never
 * builds one enormous string and hashes it on the single thread `/collect` is served from.
 *
 * The bytes must stay exactly what serialising the whole array produces. If they drift,
 * every batch already sitting in `ingest_batches` under its old id, and every marker in
 * the completed queue row, stops matching — and a redelivery that should have been
 * skipped is applied a second time instead.
 */
describe("digest bytes", () => {
  function wholeArrayDigest(rows: readonly unknown[]): string {
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 32);
  }

  const cases: [string, unknown[]][] = [
    ["an empty batch", []],
    ["one row", [pageview()]],
    ["several rows", [pageview(), pageview({ sid: "sess_2" }), pageview({ page: "/x" })]],
    ["nested data", [pageview({ data: { nx: 0.5, tags: ["a", "b"], meta: { k: 1 } } })]],
    ["primitives and holes", [null, undefined, 3, "s", true]],
  ];

  for (const [name, rows] of cases) {
    it(`matches whole-array serialisation for ${name}`, () => {
      expect(batchIdFromContent(rows)).toBe(wholeArrayDigest(rows));
    });
  }
});
