import { describe, expect, it } from "bun:test";
import type { HeatmapIngestEvent } from "../../../platform/lib/types";
import { eventsToPoints } from "../services/point-mapping";

// A plain static import, and no `DATABASE_URL` to fake. That is the point of the split:
// this used to reach these functions through `heatmap-ingest.service`, which pulls in
// `db` and throws while loading, so the test needed a dynamic import and a stub
// environment to test arithmetic on a plain object.

/**
 * The coordinate scale, pinned.
 *
 * `x_percent` and `y_percent` are not percentages. A click is stored at 10000× and a
 * scroll depth at 100×, in the same two integer columns, distinguished only by
 * `event_type`. The dashboard divides by the matching factor, and the raw public API
 * hands the values out unchanged.
 *
 * Nothing in the type system relates the writer to either reader — the multiplier lives
 * in `eventsToPoints`, the divisor in a `.tsx` file, and the field names actively
 * mislead about both. So the contract is asserted here: changing a factor should fail
 * this file rather than quietly move every heatmap point on the page.
 */

function click(nx: number, ny: number, extra: Record<string, unknown> = {}): HeatmapIngestEvent {
  return {
    websiteId: "w1",
    type: "heatmap_click",
    url: "https://example.com/pricing",
    clientUa: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    ts: 1_770_000_000_000,
    data: { nx, ny, target: "button#buy", ...extra },
  } as unknown as HeatmapIngestEvent;
}

function scroll(depth: number, extra: Record<string, unknown> = {}): HeatmapIngestEvent {
  return {
    websiteId: "w1",
    type: "heatmap_scroll",
    url: "https://example.com/pricing",
    clientUa: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    ts: 1_770_000_000_000,
    data: { depth, ...extra },
  } as unknown as HeatmapIngestEvent;
}

describe("click coordinates", () => {
  it("are stored at 10000x, not as whole percents", () => {
    const [p] = eventsToPoints([click(0.5, 0.25)]);
    expect(p!.xPercent).toBe(5000);
    expect(p!.yPercent).toBe(2500);
  });

  it("span the full 0–10000 range", () => {
    expect(eventsToPoints([click(0, 0)])[0]).toMatchObject({ xPercent: 0, yPercent: 0 });
    expect(eventsToPoints([click(1, 1)])[0]).toMatchObject({ xPercent: 10000, yPercent: 10000 });
  });

  it("keep sub-percent resolution, which is the reason for the factor", () => {
    // At 100x these two clicks would collide into one cell and the heatmap would band.
    const a = eventsToPoints([click(0.5001, 0)])[0]!;
    const b = eventsToPoints([click(0.5009, 0)])[0]!;
    expect(a.xPercent).not.toBe(b.xPercent);
  });

  it("are clamped to the range rather than trusted", () => {
    expect(eventsToPoints([click(1.5, -0.2)])[0]).toMatchObject({ xPercent: 10000, yPercent: 0 });
  });

  it("treat a missing or unparseable coordinate as 0", () => {
    expect(eventsToPoints([click(NaN as never, "x" as never)])[0]).toMatchObject({
      xPercent: 0,
      yPercent: 0,
    });
  });
});

describe("scroll depth", () => {
  it("is stored at 100x — a different factor from clicks, in the same column", () => {
    expect(eventsToPoints([scroll(0.5)])[0]!.yPercent).toBe(50);
    expect(eventsToPoints([scroll(1)])[0]!.yPercent).toBe(100);
  });

  it("always reports x as 0, since a scroll has no horizontal position", () => {
    expect(eventsToPoints([scroll(0.75)])[0]!.xPercent).toBe(0);
  });

  it("carries no target selector", () => {
    // Empty rather than null: the column is NOT NULL, and the cell's unique index
    // includes it — a null would make every scroll row its own cell.
    expect(eventsToPoints([scroll(0.5)])[0]!.targetSelector).toBe("");
  });

  it("is clamped", () => {
    expect(eventsToPoints([scroll(2)])[0]!.yPercent).toBe(100);
    expect(eventsToPoints([scroll(-1)])[0]!.yPercent).toBe(0);
  });
});

describe("the two scales are genuinely different", () => {
  /**
   * The whole hazard in one assertion: identical inputs, same columns, 100× apart.
   */
  it("stores the same 0.5 as 5000 for a click and 50 for a scroll", () => {
    expect(eventsToPoints([click(0, 0.5)])[0]!.yPercent).toBe(5000);
    expect(eventsToPoints([scroll(0.5)])[0]!.yPercent).toBe(50);
  });
});

describe("viewport caps", () => {
  it("are kept when plausible", () => {
    expect(eventsToPoints([click(0.5, 0.5, { vw: 1440, vh: 900 })])[0]).toMatchObject({
      capVw: 1440,
      capVh: 900,
    });
  });

  it("are dropped when outside a realistic CSS viewport range", () => {
    expect(eventsToPoints([click(0.5, 0.5, { vw: 4, vh: 99999 })])[0]).toMatchObject({
      capVw: null,
      capVh: null,
    });
  });
});

describe("path handling", () => {
  function pathFor(url: string) {
    return eventsToPoints([{ ...click(0.5, 0.5), url }])[0]!.pagePath;
  }

  it("collapses a long numeric id so a dynamic route is one heatmap", () => {
    expect(pathFor("https://example.com/orders/8213994?ref=x")).toBe("/orders/:id");
  });

  it("collapses a uuid segment", () => {
    expect(pathFor("https://example.com/u/11111111-2222-3333-4444-555555555555")).toBe("/u/:id");
  });

  /**
   * The numeric rule needs six digits or more, so short numbers survive. That is
   * deliberate — `/page/2` is pagination, not an id, and collapsing it would merge
   * genuinely different pages into one heatmap.
   */
  it("leaves a short number alone", () => {
    expect(pathFor("https://example.com/page/2")).toBe("/page/2");
    expect(pathFor("https://example.com/orders/8213")).toBe("/orders/8213");
  });

  it("drops the query string", () => {
    expect(pathFor("https://example.com/pricing?utm_source=x")).toBe("/pricing");
  });
});
