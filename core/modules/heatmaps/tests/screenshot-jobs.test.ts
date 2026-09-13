import { describe, expect, it } from "bun:test";
import type { HeatmapIngestEvent } from "../../../platform/lib/types";
import { eventsToScreenshotJobs } from "../services/heatmap-event-projection.service";
import { isJpeg, mergeNormalizedPages, pageUrlOnSite } from "../services/heatmap-data-normalization.service";
import type { PageSummaryRow } from "../interfaces";

/**
 * The tracker-image decode path, and the read-side page merge.
 *
 * `point-scaling.test.ts` covers `eventsToPoints` — the click/scroll half of
 * `point-mapping`. `eventsToScreenshotJobs` had nothing, and it is the more hostile of
 * the two: it takes a base64 blob from a public endpoint and decides whether to spend an
 * S3 upload on it. Every rejection is a total function on the event, which makes it cheap
 * to test and easy to leave untested.
 *
 * `mergeNormalizedPages` is the mirror image on the read side. It merges rows written
 * *before* a normalization rule existed, so `/orders/821399` and `/orders/990244` collapse
 * into one `/orders/:id` row in the dashboard. Without it the page list grows one row per
 * order id, and the two functions have to agree on the same normalization or a page
 * appears twice.
 *
 * Six digits, not four: `HeatmapQuery`'s own doc comment offers `/orders/8213` as an
 * example of a path that merges, and it does not — see the boundary tests below.
 *
 * A plain static import: none of this touches the database, which is the point of the
 * split these functions live behind.
 */

const SITE = "11111111-1111-4111-8111-111111111111";

/** A base64 payload that decodes to a plausible JPEG of `bytes` length. */
function jpegBase64(bytes = 1000, prefix = false): string {
  const b = Buffer.alloc(bytes, 1);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  const raw = b.toString("base64");
  return prefix ? `data:image/jpeg;base64,${raw}` : raw;
}

function screenshotEvent(
  data: Record<string, unknown> = {},
  over: Partial<HeatmapIngestEvent> = {},
): HeatmapIngestEvent {
  return {
    type: "heatmap_screenshot",
    ts: 1_767_225_600_000,
    websiteId: SITE,
    heatmapLayoutEnabled: true,
    url: "https://shop.test/pricing",
    docW: 1440,
    docH: 3000,
    data: { image: jpegBase64(), ...data },
    ...over,
  };
}

function row(over: Partial<PageSummaryRow> = {}): PageSummaryRow {
  return {
    page_path: "/pricing",
    click_count: 10,
    scroll_count: 5,
    avg_scroll: 50,
    last_seen: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

describe("eventsToScreenshotJobs", () => {
  describe("event selection", () => {
    it("keeps only screenshot events", () => {
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent(),
        screenshotEvent({}, { type: "heatmap_click" }),
        screenshotEvent({}, { type: "heatmap_scroll" }),
        screenshotEvent({}, { type: "heatmap_dom_snapshot" }),
        screenshotEvent({}, { type: "pageview" }),
      ]);

      expect(jobs).toHaveLength(1);
    });

    it("returns nothing for an empty batch", () => {
      expect(eventsToScreenshotJobs(SITE, [])).toEqual([]);
    });

    it("returns nothing for a batch with no screenshots", () => {
      expect(
        eventsToScreenshotJobs(SITE, [screenshotEvent({}, { type: "heatmap_click" })]),
      ).toEqual([]);
    });

    it("keeps one job per screenshot event", () => {
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({}, { url: "https://shop.test/a" }),
        screenshotEvent({}, { url: "https://shop.test/b" }),
      ]);

      expect(jobs.map((j) => j.url)).toEqual(["https://shop.test/a", "https://shop.test/b"]);
    });
  });

  describe("the image payload", () => {
    it("decodes a bare base64 image", () => {
      const jobs = eventsToScreenshotJobs(SITE, [screenshotEvent({ image: jpegBase64(1000) })]);

      expect(jobs[0]!.jpeg.length).toBe(1000);
    });

    it("strips a data-URI prefix", () => {
      // Browsers send `data:image/jpeg;base64,…`; decoding that verbatim yields bytes
      // that are not a JPEG and the event would be dropped.
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({ image: jpegBase64(1000, true) }),
      ]);

      expect(jobs[0]!.jpeg.length).toBe(1000);
    });

    it("trims surrounding whitespace", () => {
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({ image: `  ${jpegBase64(1000)}  ` }),
      ]);

      expect(jobs).toHaveLength(1);
    });

    it("drops an event with no image", () => {
      const jobs = eventsToScreenshotJobs(SITE, [screenshotEvent({ image: undefined })]);

      expect(jobs).toEqual([]);
    });

    it("drops an event with an empty image", () => {
      expect(eventsToScreenshotJobs(SITE, [screenshotEvent({ image: "" })])).toEqual([]);
    });

    it("drops an event whose image is only whitespace", () => {
      expect(eventsToScreenshotJobs(SITE, [screenshotEvent({ image: "   " })])).toEqual([]);
    });

    it("drops a non-string image rather than coercing it", () => {
      expect(eventsToScreenshotJobs(SITE, [screenshotEvent({ image: 12345 })])).toEqual([]);
      expect(eventsToScreenshotJobs(SITE, [screenshotEvent({ image: {} })])).toEqual([]);
      expect(eventsToScreenshotJobs(SITE, [screenshotEvent({ image: null })])).toEqual([]);
    });

    it("drops an event with no data object at all", () => {
      expect(eventsToScreenshotJobs(SITE, [screenshotEvent({}, { data: undefined })])).toEqual(
        [],
      );
    });

    it("drops a payload below the 400-byte floor", () => {
      // Under 400 bytes there is no page in there, whatever the magic bytes say.
      expect(eventsToScreenshotJobs(SITE, [screenshotEvent({ image: jpegBase64(399) })])).toEqual(
        [],
      );
    });

    it("accepts a payload exactly at the floor", () => {
      const jobs = eventsToScreenshotJobs(SITE, [screenshotEvent({ image: jpegBase64(400) })]);

      expect(jobs).toHaveLength(1);
    });

    it("drops a payload above the 4 MiB ceiling", () => {
      // Deliberately tighter than the dashboard's 10 MiB in `heatmap-layout-snapshot.service`:
      // this one arrives from a public endpoint at tracker volume.
      const over = jpegBase64((4 << 20) + 1);

      expect(eventsToScreenshotJobs(SITE, [screenshotEvent({ image: over })])).toEqual([]);
    });

    it("accepts a payload exactly at the ceiling", () => {
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({ image: jpegBase64(4 << 20) }),
      ]);

      expect(jobs).toHaveLength(1);
    });

    it("drops bytes that are not a JPEG, whatever their length", () => {
      const notJpeg = Buffer.alloc(5000, 7).toString("base64");

      expect(eventsToScreenshotJobs(SITE, [screenshotEvent({ image: notJpeg })])).toEqual([]);
    });

    it("drops a PNG", () => {
      // A real image, just not the format this path stores.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(996).fill(0)]).toString(
        "base64",
      );

      expect(eventsToScreenshotJobs(SITE, [screenshotEvent({ image: png })])).toEqual([]);
    });

    it("drops one bad payload without losing the rest of the batch", () => {
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({ image: jpegBase64() }, { url: "https://shop.test/a" }),
        screenshotEvent({ image: "garbage" }, { url: "https://shop.test/b" }),
        screenshotEvent({ image: jpegBase64() }, { url: "https://shop.test/c" }),
      ]);

      expect(jobs.map((j) => j.url)).toEqual(["https://shop.test/a", "https://shop.test/c"]);
    });
  });

  describe("what it carries through", () => {
    it("keeps the event's own website id, not the batch argument", () => {
      // The batch argument is unused for this field on purpose: a `/collect` batch can
      // carry events for more than one site, and attributing them all to the first
      // would store one site's screenshots under another.
      const jobs = eventsToScreenshotJobs("batch-level-site", [
        screenshotEvent({}, { websiteId: "event-level-site" }),
      ]);

      expect(jobs[0]!.websiteId).toBe("event-level-site");
    });

    it("carries the layout flag through", () => {
      const on = eventsToScreenshotJobs(SITE, [
        screenshotEvent({}, { heatmapLayoutEnabled: true }),
      ]);
      const off = eventsToScreenshotJobs(SITE, [
        screenshotEvent({}, { heatmapLayoutEnabled: false }),
      ]);

      expect(on[0]!.heatmapLayoutEnabled).toBe(true);
      expect(off[0]!.heatmapLayoutEnabled).toBe(false);
    });

    it("defaults an unset layout flag to disabled", () => {
      // Fail closed: an unset flag must not authorise storing a page render.
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({}, { heatmapLayoutEnabled: undefined }),
      ]);

      expect(jobs[0]!.heatmapLayoutEnabled).toBe(false);
    });

    it("keeps the raw url, leaving normalization to the consumer", () => {
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({}, { url: "https://shop.test/orders/8213?x=1" }),
      ]);

      expect(jobs[0]!.url).toBe("https://shop.test/orders/8213?x=1");
    });

    it("treats a missing url as empty rather than undefined", () => {
      const jobs = eventsToScreenshotJobs(SITE, [screenshotEvent({}, { url: undefined })]);

      expect(jobs[0]!.url).toBe("");
    });
  });

  describe("document dimensions", () => {
    it("takes the envelope dimensions when the payload has none", () => {
      const jobs = eventsToScreenshotJobs(SITE, [screenshotEvent({}, { docW: 1440, docH: 3000 })]);

      expect(jobs[0]).toMatchObject({ docW: 1440, docH: 3000 });
    });

    it("prefers the payload dimensions over the envelope", () => {
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({ doc_w: 390, doc_h: 844 }, { docW: 1440, docH: 3000 }),
      ]);

      expect(jobs[0]).toMatchObject({ docW: 390, docH: 844 });
    });

    it("keeps the envelope value when the payload reports zero", () => {
      // `> 0`, not "present": a client sending `doc_w: 0` has measured nothing, and the
      // envelope's value is the better guess.
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({ doc_w: 0 }, { docW: 1440 }),
      ]);

      expect(jobs[0]!.docW).toBe(1440);
    });

    it("keeps the envelope value when the payload reports a negative", () => {
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({ doc_w: -390 }, { docW: 1440 }),
      ]);

      expect(jobs[0]!.docW).toBe(1440);
    });

    it("parses a numeric string dimension", () => {
      const jobs = eventsToScreenshotJobs(SITE, [screenshotEvent({ doc_w: "390", doc_h: "844" })]);

      expect(jobs[0]).toMatchObject({ docW: 390, docH: 844 });
    });

    it("ignores an unparseable string dimension", () => {
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({ doc_w: "wide" }, { docW: 1440 }),
      ]);

      expect(jobs[0]!.docW).toBe(1440);
    });

    it("truncates a fractional dimension", () => {
      const jobs = eventsToScreenshotJobs(SITE, [screenshotEvent({ doc_w: 390.9 })]);

      expect(jobs[0]!.docW).toBe(390);
    });

    it("defaults to zero when neither source has a dimension", () => {
      // Zero rather than undefined, so the consumer's plausibility fallback is what
      // decides the stored value — see `snapshot-ingest.test.ts`.
      const jobs = eventsToScreenshotJobs(SITE, [
        screenshotEvent({}, { docW: undefined, docH: undefined }),
      ]);

      expect(jobs[0]).toMatchObject({ docW: 0, docH: 0 });
    });

    it("never emits a non-integer dimension", () => {
      const inputs: unknown[] = [390.9, "390.9", "wide", null, {}, Number.NaN, Infinity, -1];

      for (const doc_w of inputs) {
        const jobs = eventsToScreenshotJobs(SITE, [screenshotEvent({ doc_w }, { docW: 1440 })]);

        expect(Number.isInteger(jobs[0]!.docW)).toBe(true);
      }
    });
  });
});

describe("isJpeg", () => {
  it("accepts the SOI marker", () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe(true);
  });

  it("rejects a buffer shorter than the marker", () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });

  it("rejects an empty buffer", () => {
    expect(isJpeg(new Uint8Array([]))).toBe(false);
  });

  it("rejects a PNG header", () => {
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });

  it("checks all three bytes, not just the first two", () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0x00]))).toBe(false);
  });
});

describe("mergeNormalizedPages", () => {
  it("returns nothing for no rows", () => {
    expect(mergeNormalizedPages([])).toEqual([]);
  });

  it("passes a single row through under its normalized path", () => {
    const out = mergeNormalizedPages([row({ page_path: "/pricing/" })]);

    expect(out).toHaveLength(1);
    expect(out[0]!.page_path).toBe("/pricing");
  });

  it("merges rows that differ only in a dynamic id", () => {
    // The reason this is not a `GROUP BY`: rows written before `/orders/:id` existed
    // still carry the raw path, so the dashboard would show one row per order.
    const out = mergeNormalizedPages([
      row({ page_path: "/orders/821399", click_count: 10 }),
      row({ page_path: "/orders/990244", click_count: 5 }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ page_path: "/orders/:id", click_count: 15 });
  });

  it("leaves a short numeric segment unmerged", () => {
    // The rule collapses six digits or more. Four-digit ids stay distinct, so a site
    // with low-numbered order ids still gets one row per order — worth knowing, and
    // worth failing on if the threshold moves. Note `HeatmapQuery`'s own doc comment
    // uses `/orders/8213` as an example of a path that merges; it does not.
    const out = mergeNormalizedPages([
      row({ page_path: "/orders/8213" }),
      row({ page_path: "/orders/9902" }),
    ]);

    expect(out).toHaveLength(2);
  });

  it("merges at exactly six digits", () => {
    const out = mergeNormalizedPages([
      row({ page_path: "/orders/821399" }),
      row({ page_path: "/orders/990244" }),
    ]);

    expect(out).toHaveLength(1);
  });

  it("sums scroll counts as well as clicks", () => {
    const out = mergeNormalizedPages([
      row({ page_path: "/orders/1111111", scroll_count: 3 }),
      row({ page_path: "/orders/2222222", scroll_count: 4 }),
    ]);

    expect(out[0]!.scroll_count).toBe(7);
  });

  it("keeps the most recent last_seen", () => {
    const out = mergeNormalizedPages([
      row({ page_path: "/orders/1111111", last_seen: "2026-08-01T00:00:00.000Z" }),
      row({ page_path: "/orders/2222222", last_seen: "2026-09-01T00:00:00.000Z" }),
    ]);

    expect(out[0]!.last_seen).toBe("2026-09-01T00:00:00.000Z");
  });

  it("keeps the most recent last_seen regardless of row order", () => {
    const out = mergeNormalizedPages([
      row({ page_path: "/orders/1111111", last_seen: "2026-09-01T00:00:00.000Z" }),
      row({ page_path: "/orders/2222222", last_seen: "2026-08-01T00:00:00.000Z" }),
    ]);

    expect(out[0]!.last_seen).toBe("2026-09-01T00:00:00.000Z");
  });

  it("averages avg_scroll over the merged rows, unweighted", () => {
    // Documented behaviour, not an oversight: the figure is a rough depth indicator
    // rather than a statistic anyone sums, and this is what the endpoint has always
    // returned. Pinned so a change to a count-weighted mean is a deliberate one.
    const out = mergeNormalizedPages([
      row({ page_path: "/orders/1111111", avg_scroll: 20, scroll_count: 1 }),
      row({ page_path: "/orders/2222222", avg_scroll: 80, scroll_count: 999 }),
    ]);

    expect(out[0]!.avg_scroll).toBe(50);
  });

  it("rounds the averaged scroll depth", () => {
    const out = mergeNormalizedPages([
      row({ page_path: "/orders/1111111", avg_scroll: 10 }),
      row({ page_path: "/orders/2222222", avg_scroll: 11 }),
      row({ page_path: "/orders/3333333", avg_scroll: 11 }),
    ]);

    expect(out[0]!.avg_scroll).toBe(11);
  });

  it("keeps genuinely different pages apart", () => {
    const out = mergeNormalizedPages([
      row({ page_path: "/pricing" }),
      row({ page_path: "/features" }),
    ]);

    expect(out).toHaveLength(2);
  });

  it("orders by click count, busiest first", () => {
    const out = mergeNormalizedPages([
      row({ page_path: "/quiet", click_count: 1 }),
      row({ page_path: "/busy", click_count: 100 }),
      row({ page_path: "/middling", click_count: 50 }),
    ]);

    expect(out.map((p) => p.page_path)).toEqual(["/busy", "/middling", "/quiet"]);
  });

  it("orders by the merged total, not by any single row", () => {
    // Sorting before merging would put `/loud` first on its single row of 60.
    const out = mergeNormalizedPages([
      row({ page_path: "/loud", click_count: 60 }),
      row({ page_path: "/orders/1111111", click_count: 50 }),
      row({ page_path: "/orders/2222222", click_count: 50 }),
    ]);

    expect(out[0]!.page_path).toBe("/orders/:id");
  });

  it("merges a raw path with an already-normalized one", () => {
    // The mixed case, which is the real state of the table: rows written before the
    // rule existed alongside rows written after it.
    const out = mergeNormalizedPages([
      row({ page_path: "/orders/821399", click_count: 10 }),
      row({ page_path: "/orders/:id", click_count: 5 }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.click_count).toBe(15);
  });

  it("strips a query string before merging", () => {
    const out = mergeNormalizedPages([
      row({ page_path: "/pricing?utm=a", click_count: 10 }),
      row({ page_path: "/pricing?utm=b", click_count: 5 }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ page_path: "/pricing", click_count: 15 });
  });
});

describe("pageUrlOnSite", () => {
  it("builds an absolute url from a bare hostname", () => {
    // Stored urls are bare hostnames as often as not, and both `new URL` and Playwright
    // reject one without a scheme.
    expect(pageUrlOnSite("shop.test", "/pricing")).toBe("https://shop.test/pricing");
  });

  it("keeps an existing https scheme", () => {
    expect(pageUrlOnSite("https://shop.test", "/pricing")).toBe("https://shop.test/pricing");
  });

  it("keeps an existing http scheme rather than upgrading it", () => {
    expect(pageUrlOnSite("http://shop.test", "/pricing")).toBe("http://shop.test/pricing");
  });

  it("strips a trailing slash from the stored domain", () => {
    expect(pageUrlOnSite("https://shop.test/", "/pricing")).toBe("https://shop.test/pricing");
  });

  it("strips several trailing slashes", () => {
    expect(pageUrlOnSite("https://shop.test///", "/pricing")).toBe("https://shop.test/pricing");
  });

  it("trims surrounding whitespace", () => {
    expect(pageUrlOnSite("  shop.test  ", "/pricing")).toBe("https://shop.test/pricing");
  });

  it("produces a single slash for the root path", () => {
    expect(pageUrlOnSite("shop.test", "/")).toBe("https://shop.test/");
  });

  it("returns undefined when there is no stored domain", () => {
    // The caller's signal to fall back to scanning real pageview urls, rather than
    // capturing a url built from nothing.
    expect(pageUrlOnSite("", "/pricing")).toBeUndefined();
  });

  it("returns undefined for a whitespace-only domain", () => {
    expect(pageUrlOnSite("   ", "/pricing")).toBeUndefined();
  });

  it("keeps a path with a subdirectory", () => {
    expect(pageUrlOnSite("shop.test", "/eu/pricing")).toBe("https://shop.test/eu/pricing");
  });

  it("preserves a normalized dynamic path verbatim", () => {
    // The capture target for `/orders/:id` is a literal url containing `:id`. Pinned
    // because it looks like a bug and is not — the SSRF guard and Playwright both
    // still receive a well-formed url, and the caller is responsible for choosing a
    // real path.
    expect(pageUrlOnSite("shop.test", "/orders/:id")).toBe("https://shop.test/orders/:id");
  });

  it("is case-preserving on the host", () => {
    expect(pageUrlOnSite("Shop.Test", "/p")).toBe("https://Shop.Test/p");
  });
});
