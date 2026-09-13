import { describe, expect, it } from "bun:test";
import type { HeatmapTrackerEvent } from "../interfaces";
import { trackerRowsToHeatmapEvents } from "../services/tracker-heatmap-event-mapping.service";

/**
 * The one genuine projection in the ingest path.
 *
 * Analytics' and recordings' mappings are near-identity — their wire shape already matches
 * their row shape. This one renames fields (`doc_w` → `docW`), defaults others, and decides
 * which event types belong to heatmaps at all. All three used to live in
 * `modules/ingest/services/collect-handlers.ts` as three near-duplicate functions.
 */

function ev(overrides: Partial<HeatmapTrackerEvent> = {}): HeatmapTrackerEvent {
  return {
    type: "heatmap_click",
    ts: 1_767_225_600_000,
    sid: "sess_1",
    vid: "vis_1",
    url: "https://example.com/pricing",
    websiteId: "11111111-1111-4111-8111-111111111111",
    clientUa: "Mozilla/5.0",
    heatmapLayoutEnabled: true,
    doc_w: 1440,
    doc_h: 900,
    ...overrides,
  };
}

describe("trackerRowsToHeatmapEvents", () => {
  describe("type filtering", () => {
    it("keeps the four heatmap types", () => {
      const rows = [
        ev({ type: "heatmap_click" }),
        ev({ type: "heatmap_scroll" }),
        ev({ type: "heatmap_screenshot" }),
        ev({ type: "heatmap_dom_snapshot" }),
      ];
      expect(trackerRowsToHeatmapEvents(rows).map((e) => e.type)).toEqual([
        "heatmap_click",
        "heatmap_scroll",
        "heatmap_screenshot",
        "heatmap_dom_snapshot",
      ]);
    });

    /**
     * A `/collect` body is a mixed batch — pageviews, funnel steps, rrweb chunks and
     * heatmap events arrive together. Anything not ours is another module's row and must
     * not reach the heatmap engine.
     */
    it("drops every other type", () => {
      const rows = [
        ev({ type: "pageview" }),
        ev({ type: "rrweb" }),
        ev({ type: "funnel_step" }),
        ev({ type: "automation_trigger" }),
      ];
      expect(trackerRowsToHeatmapEvents(rows)).toEqual([]);
    });

    it("returns an empty array for an empty batch", () => {
      expect(trackerRowsToHeatmapEvents([])).toEqual([]);
    });
  });

  describe("projection", () => {
    /** The rename is the reason this function exists rather than a cast. */
    it("renames the document dimensions to this module's names", () => {
      const [out] = trackerRowsToHeatmapEvents([ev({ doc_w: 1280, doc_h: 720 })]);
      expect(out?.docW).toBe(1280);
      expect(out?.docH).toBe(720);
    });

    it("carries the identifiers and page context through", () => {
      const [out] = trackerRowsToHeatmapEvents([ev()]);
      expect(out).toMatchObject({
        websiteId: "11111111-1111-4111-8111-111111111111",
        sid: "sess_1",
        vid: "vis_1",
        url: "https://example.com/pricing",
        ts: 1_767_225_600_000,
        clientUa: "Mozilla/5.0",
      });
    });

    /** Downstream reads `data` unconditionally, so a missing payload becomes an object. */
    it("defaults a missing data payload to an empty object", () => {
      const [out] = trackerRowsToHeatmapEvents([ev({ data: undefined })]);
      expect(out?.data).toEqual({});
    });

    /**
     * Defaulted to `false`, never left undefined: the engine gates DOM-snapshot storage on
     * this flag, and `undefined` there would read as "enabled" under a loose check.
     */
    it("defaults layout capture to disabled when unset", () => {
      const [out] = trackerRowsToHeatmapEvents([ev({ heatmapLayoutEnabled: undefined })]);
      expect(out?.heatmapLayoutEnabled).toBe(false);
    });

    it("preserves an enabled layout flag", () => {
      const [out] = trackerRowsToHeatmapEvents([ev({ heatmapLayoutEnabled: true })]);
      expect(out?.heatmapLayoutEnabled).toBe(true);
    });
  });

  /**
   * Both context fields are per event rather than per batch, because the ingest buffer
   * accumulates across requests: it holds events from many visitors (different user agents)
   * and many websites (different layout settings) at the same time.
   */
  it("keeps per-event context distinct within one batch", () => {
    const out = trackerRowsToHeatmapEvents([
      ev({ clientUa: "UA-one", websiteId: "site-1", heatmapLayoutEnabled: true }),
      ev({ clientUa: "UA-two", websiteId: "site-2", heatmapLayoutEnabled: false }),
    ]);

    expect(out.map((e) => e.clientUa)).toEqual(["UA-one", "UA-two"]);
    expect(out.map((e) => e.websiteId)).toEqual(["site-1", "site-2"]);
    expect(out.map((e) => e.heatmapLayoutEnabled)).toEqual([true, false]);
  });
});
