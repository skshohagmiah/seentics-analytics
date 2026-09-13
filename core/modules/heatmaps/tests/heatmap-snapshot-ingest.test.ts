import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import type { HeatmapIngestEvent, ScreenshotJob } from "../../../platform/lib/types";
import type { LayoutSnapshotRow } from "../lib/layout-db";
import type {
  TrackerGoal,
  TrackerWebsites,
  WebsiteTrackerRow,
} from "../../websites/interfaces";

/**
 * The page-background half of heatmap ingest — the picture a heatmap is drawn over.
 *
 * This file is 231 lines of decisions that are all invisible from the outside, and it had
 * no tests. Three of them are the reason it needs some:
 *
 * 1. **Deduplication is layered, cheapest first** — the in-process hash cache, then the
 *    stored row's hash, then the upload. The tracker re-sends the same page image on
 *    every session, so a layer that silently stops working is not a correctness bug you
 *    would notice: it is an S3 bill. Each layer is asserted here by counting uploads.
 * 2. **The Playwright trigger is an unattended SSRF surface.** It runs off an ingest
 *    flush, fed by a `url` that arrived at a public endpoint, with no user to attribute
 *    it to. It must check the target against the site's registered domain, and it must
 *    refuse to capture at all when there is no resolver to check against. The real
 *    `validateScreenshotTargetUrl` is used rather than a stub, so these tests fail if the
 *    guard is bypassed *or* if it is removed.
 * 3. **`plausibleDocSize` decides where every point lands.** Heatmap points are stored as
 *    fractions of the document, so a zero document width does not degrade the render —
 *    it stacks every point on the origin.
 *
 * `layout-db` and `playwright-screenshots` are stubbed because the first opens `db` at
 * module scope and the second launches a browser. Both stubs list every runtime export;
 * see `app/tests/mock-completeness.test.ts`.
 */

process.env.DATABASE_URL ??= "postgres://test-not-connected";

/** Hashes `getCachedSnapshotSha256` should report, keyed `websiteId:pagePath`. */
const cachedHashes = new Map<string, string>();
/** Rows `getLayoutSnapshot` should report, keyed `websiteId:pagePath`. */
const storedRows = new Map<string, LayoutSnapshotRow>();
/** Every `upsertLayoutSnapshot` call, in order. */
const jpegUpserts: {
  websiteId: string;
  pagePath: string;
  device: string;
  key: string;
  sha: string;
  w: number;
  h: number;
}[] = [];
/** Every `upsertLayoutHtmlSnapshot` call, in order. */
const htmlUpserts: {
  websiteId: string;
  pagePath: string;
  device: string;
  key: string;
  sha: string;
  w: number;
  h: number;
}[] = [];
/** Set to make the row read fail, so a test can check the failure is not swallowed. */
let layoutReadThrows = false;

mock.module("../lib/layout-db", () => ({
  getCachedSnapshotSha256: (websiteId: string, pagePath: string) =>
    cachedHashes.get(`${websiteId}:${pagePath}`) ?? null,
  getLayoutSnapshot: async (websiteId: string, pagePath: string) => {
    if (layoutReadThrows) throw new Error("layout row read failed");
    return storedRows.get(`${websiteId}:${pagePath}`) ?? null;
  },
  upsertLayoutSnapshot: async (
    websiteId: string,
    pagePath: string,
    device: string,
    key: string,
    sha: string,
    w: number,
    h: number,
  ) => {
    jpegUpserts.push({ websiteId, pagePath, device, key, sha, w, h });
  },
  upsertLayoutHtmlSnapshot: async (
    websiteId: string,
    pagePath: string,
    device: string,
    key: string,
    sha: string,
    w: number,
    h: number,
  ) => {
    htmlUpserts.push({ websiteId, pagePath, device, key, sha, w, h });
  },
}));

/** URLs Playwright was asked to capture, in order. */
const playwrightCaptures: { url: string; websiteId: string; norm: string; force: boolean }[] = [];
/** Set to make the capture reject, so a test can check the failure stays contained. */
let playwrightThrows = false;

mock.module("../lib/playwright-screenshots", () => ({
  captureAndStoreScreenshot: async (
    url: string,
    _bucket: string,
    websiteId: string,
    norm: string,
    opts?: { force?: boolean },
  ) => {
    playwrightCaptures.push({ url, websiteId, norm, force: opts?.force === true });
    if (playwrightThrows) throw new Error("browser died");
    return { s3Key: "k", hash: "h", width: 1, height: 1, sizeBytes: 1, stored: true };
  },
  shutdownScreenshotBrowser: async () => {},
}));

/** JPEG uploads, in order. The count is how every dedup assertion below is made. */
const jpegPuts: { key: string; bytes: number }[] = [];
/** HTML uploads, in order. */
const htmlPuts: { key: string; body: string }[] = [];
/** Set to make the upload fail, so a test can check the row is not written regardless. */
let putThrows = false;

mock.module("../../../platform/lib/s3", () => ({
  s3: () => ({}),
  putJpeg: async (_bucket: string, key: string, body: Uint8Array) => {
    if (putThrows) throw new Error("s3 unreachable");
    jpegPuts.push({ key, bytes: body.length });
  },
  putHtml: async (_bucket: string, key: string, body: string) => {
    if (putThrows) throw new Error("s3 unreachable");
    htmlPuts.push({ key, body });
  },
  deleteS3Objects: async () => {},
  getNextReplayChunkSequence: async () => 0,
  uploadSessionChunkGzip: async () => {},
  deleteSessionPrefix: async () => {},
  listSessionReplayChunks: async () => [],
  presignGet: async (_bucket: string, key: string) => `https://signed.test/${key}`,
  locateBundle: async () => null,
  getJsonGzip: async () => [],
}));

const { SnapshotIngestService } = await import("../services/heatmap-snapshot-ingest.service");

const BUCKET = "test-bucket";
const SITE = "11111111-1111-4111-8111-111111111111";

/** A buffer that clears the JPEG magic-byte and minimum-size checks. */
function jpeg(bytes = 500, fill = 1): Uint8Array {
  const b = new Uint8Array(bytes).fill(fill);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
}

/** A buffer with the right length but the wrong leading bytes. */
function notJpeg(bytes = 500): Uint8Array {
  return new Uint8Array(bytes).fill(7);
}

function job(over: Partial<ScreenshotJob> = {}): ScreenshotJob {
  return {
    websiteId: SITE,
    heatmapLayoutEnabled: true,
    url: "https://shop.test/pricing",
    jpeg: jpeg(),
    docW: 1440,
    docH: 3000,
    ...over,
  };
}

function domEvent(over: Partial<HeatmapIngestEvent> = {}): HeatmapIngestEvent {
  return {
    type: "heatmap_dom_snapshot",
    ts: 1_767_225_600_000,
    websiteId: SITE,
    heatmapLayoutEnabled: true,
    url: "https://shop.test/pricing",
    data: { html: "<html>".padEnd(200, "x") + "</html>" },
    docW: 1440,
    docH: 3000,
    ...over,
  };
}

function sha256(v: Uint8Array | string): string {
  return createHash("sha256").update(v).digest("hex");
}

function row(over: Partial<LayoutSnapshotRow> = {}): LayoutSnapshotRow {
  return {
    page_path: "/pricing",
    s3_key: "heatmap-screenshots/site/slot.jpg",
    content_sha256: "some-other-hash",
    doc_width: 1440,
    doc_height: 3000,
    html_s3_key: null,
    device_type: "desktop",
    updated_at: new Date("2026-09-01T00:00:00.000Z"),
    ...over,
  };
}

/** A resolver reporting one site on `shop.test`. */
function resolverFor(url: string, calls: string[] = []): TrackerWebsites {
  return {
    async resolve(websiteRef: string): Promise<WebsiteTrackerRow | null> {
      calls.push(websiteRef);
      return { id: SITE, url } as WebsiteTrackerRow;
    },
    async listGoals(): Promise<TrackerGoal[]> {
      return [];
    },
    async buildConfig(): Promise<Record<string, unknown>> {
      return {};
    },
  };
}

/** A resolver that knows nothing — the website was deleted between ingest and flush. */
const unknownResolver: TrackerWebsites = {
  async resolve() {
    return null;
  },
  async listGoals() {
    return [];
  },
  async buildConfig() {
    return {};
  },
};

/** Lets the fire-and-forget Playwright trigger settle before asserting on it. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function service(websites: TrackerWebsites | null = null) {
  return new SnapshotIngestService(BUCKET, websites);
}

beforeEach(() => {
  cachedHashes.clear();
  storedRows.clear();
  jpegUpserts.length = 0;
  htmlUpserts.length = 0;
  jpegPuts.length = 0;
  htmlPuts.length = 0;
  playwrightCaptures.length = 0;
  layoutReadThrows = false;
  playwrightThrows = false;
  putThrows = false;
});

describe("SnapshotIngestService.storeScreenshot", () => {
  describe("what it refuses to store", () => {
    it("stores nothing when layout capture is off for the site", async () => {
      await service().storeScreenshot(job({ heatmapLayoutEnabled: false }));

      expect(jpegPuts).toEqual([]);
      expect(jpegUpserts).toEqual([]);
    });

    it("stores nothing for a job with no website id", async () => {
      await service().storeScreenshot(job({ websiteId: "" }));

      expect(jpegPuts).toEqual([]);
    });

    it("refuses a payload below the size floor", async () => {
      // Under 400 bytes there is no page in there, whatever the magic bytes say.
      await service().storeScreenshot(job({ jpeg: jpeg(399) }));

      expect(jpegPuts).toEqual([]);
    });

    it("accepts a payload exactly at the size floor", async () => {
      await service().storeScreenshot(job({ jpeg: jpeg(400) }));

      expect(jpegPuts).toHaveLength(1);
    });

    it("refuses a payload that is not a JPEG, whatever its length", async () => {
      await service().storeScreenshot(job({ jpeg: notJpeg(5000) }));

      expect(jpegPuts).toEqual([]);
      expect(jpegUpserts).toEqual([]);
    });

    it("does not trigger a capture for a job it refused", async () => {
      // The refusal has to come before the trigger, or a rejected payload is still a
      // free way to make the server fetch a page.
      const calls: string[] = [];
      await service(resolverFor("shop.test", calls)).storeScreenshot(
        job({ jpeg: notJpeg() }),
      );
      await settle();

      expect(playwrightCaptures).toEqual([]);
      expect(calls).toEqual([]);
    });
  });

  describe("storing", () => {
    it("uploads the image and records the row", async () => {
      const j = job();

      await service().storeScreenshot(j);

      expect(jpegPuts).toHaveLength(1);
      expect(jpegUpserts).toHaveLength(1);
      expect(jpegUpserts[0]).toMatchObject({
        websiteId: SITE,
        pagePath: "/pricing",
        sha: sha256(j.jpeg),
        w: 1440,
        h: 3000,
      });
    });

    it("records the row against the key it uploaded to", async () => {
      // Two independent derivations of the same S3 key would be a silent 404 on read.
      await service().storeScreenshot(job());

      expect(jpegUpserts[0]!.key).toBe(jpegPuts[0]!.key);
    });

    it("normalizes the path before storing, so a dynamic route is one snapshot", async () => {
      await service().storeScreenshot(job({ url: "https://shop.test/orders/902133" }));

      expect(jpegUpserts[0]!.pagePath).toBe("/orders/:id");
    });

    it("strips the query string from the stored path", async () => {
      await service().storeScreenshot(job({ url: "https://shop.test/pricing?utm_source=x" }));

      expect(jpegUpserts[0]!.pagePath).toBe("/pricing");
    });

    it("does not write the row when the upload failed", async () => {
      // A row pointing at an object that was never stored reads as a snapshot that
      // exists and 404s — worse than no snapshot, because the dedup layers below
      // would then skip re-uploading it.
      putThrows = true;

      await expect(service().storeScreenshot(job())).rejects.toThrow("s3 unreachable");
      expect(jpegUpserts).toEqual([]);
    });

    it("propagates a failed row read rather than storing blind", async () => {
      layoutReadThrows = true;

      await expect(service().storeScreenshot(job())).rejects.toThrow("layout row read failed");
      expect(jpegPuts).toEqual([]);
    });
  });

  describe("deduplication", () => {
    it("skips the upload when the in-process cache already has this hash", async () => {
      const j = job();
      cachedHashes.set(`${SITE}:/pricing`, sha256(j.jpeg));

      await service().storeScreenshot(j);

      expect(jpegPuts).toEqual([]);
      expect(jpegUpserts).toEqual([]);
    });

    it("does not consult the stored row when the cache answered", async () => {
      // The layering is the point: a cache hit must not cost a database read.
      const j = job();
      cachedHashes.set(`${SITE}:/pricing`, sha256(j.jpeg));
      layoutReadThrows = true;

      await service().storeScreenshot(j);

      expect(jpegPuts).toEqual([]);
    });

    it("uploads when the cache holds a different hash", async () => {
      // A cached hash that does not match means the page changed. Note this path does
      // *not* fall back to the stored row — the cache is authoritative when populated.
      cachedHashes.set(`${SITE}:/pricing`, "stale-hash-from-an-older-render");

      await service().storeScreenshot(job());

      expect(jpegPuts).toHaveLength(1);
    });

    it("falls back to the stored row on a cold cache", async () => {
      // This is the post-restart path: nothing cached, but the row from the previous
      // process still carries the hash.
      const j = job();
      storedRows.set(`${SITE}:/pricing`, row({ content_sha256: sha256(j.jpeg) }));

      await service().storeScreenshot(j);

      expect(jpegPuts).toEqual([]);
      expect(jpegUpserts).toEqual([]);
    });

    it("uploads when the stored row carries a different hash", async () => {
      storedRows.set(`${SITE}:/pricing`, row({ content_sha256: "an-older-render" }));

      await service().storeScreenshot(job());

      expect(jpegPuts).toHaveLength(1);
    });

    it("uploads when there is neither a cached hash nor a stored row", async () => {
      await service().storeScreenshot(job());

      expect(jpegPuts).toHaveLength(1);
    });

    it("dedupes per path, not per site", async () => {
      const j = job();
      cachedHashes.set(`${SITE}:/pricing`, sha256(j.jpeg));

      await service().storeScreenshot(j);
      await service().storeScreenshot(job({ url: "https://shop.test/features" }));

      expect(jpegPuts).toHaveLength(1);
      expect(jpegUpserts[0]!.pagePath).toBe("/features");
    });

    it("dedupes per site, not globally", async () => {
      const j = job();
      cachedHashes.set(`${SITE}:/pricing`, sha256(j.jpeg));

      await service().storeScreenshot(j);
      await service().storeScreenshot(job({ websiteId: "other-site" }));

      expect(jpegPuts).toHaveLength(1);
      expect(jpegUpserts[0]!.websiteId).toBe("other-site");
    });

    it("treats a one-byte difference as a different image", async () => {
      // sha256 over the whole buffer, not a length or a prefix check.
      const first = jpeg(500, 1);
      cachedHashes.set(`${SITE}:/pricing`, sha256(first));

      await service().storeScreenshot(job({ jpeg: first }));
      const second = jpeg(500, 1);
      second[499] = 2;
      await service().storeScreenshot(job({ jpeg: second }));

      expect(jpegPuts).toHaveLength(1);
    });
  });

  describe("document dimensions", () => {
    it("keeps plausible dimensions as given", async () => {
      await service().storeScreenshot(job({ docW: 1440, docH: 3000 }));

      expect(jpegUpserts[0]).toMatchObject({ w: 1440, h: 3000 });
    });

    it("substitutes a fallback for a zero width, rather than storing zero", async () => {
      // Points are fractions of the document. A zero width does not make the render
      // worse — it collapses every point onto the origin.
      await service().storeScreenshot(job({ docW: 0 }));

      expect(jpegUpserts[0]!.w).toBe(1280);
    });

    it("substitutes a fallback for a zero height", async () => {
      await service().storeScreenshot(job({ docH: 0 }));

      expect(jpegUpserts[0]!.h).toBe(800);
    });

    it("substitutes a fallback below the plausibility floor", async () => {
      await service().storeScreenshot(job({ docW: 199, docH: 199 }));

      expect(jpegUpserts[0]).toMatchObject({ w: 1280, h: 800 });
    });

    it("keeps a dimension exactly at the floor", async () => {
      await service().storeScreenshot(job({ docW: 200, docH: 200 }));

      expect(jpegUpserts[0]).toMatchObject({ w: 200, h: 200 });
    });

    it("substitutes a fallback for a negative dimension", async () => {
      await service().storeScreenshot(job({ docW: -1440, docH: -3000 }));

      expect(jpegUpserts[0]).toMatchObject({ w: 1280, h: 800 });
    });

    it("truncates a fractional dimension rather than storing a float", async () => {
      await service().storeScreenshot(job({ docW: 1440.9, docH: 3000.9 }));

      expect(jpegUpserts[0]).toMatchObject({ w: 1440, h: 3000 });
    });

    it("substitutes a fallback for a non-finite dimension", async () => {
      // Regression. `Math.trunc(NaN)` is `NaN` and `NaN < 200` is **false**, so the
      // plausibility check alone skipped the fallback for the one input class that
      // cannot be stored at all, and `NaN` reached an integer column. The finiteness
      // check is what catches it — deleting it fails here.
      await service().storeScreenshot(job({ docW: Number.NaN, docH: Number.POSITIVE_INFINITY }));

      expect(jpegUpserts[0]).toMatchObject({ w: 1280, h: 800 });
    });
  });

  describe("the Playwright re-capture trigger", () => {
    it("captures the page once the tracker's stand-in image arrives", async () => {
      const svc = service(resolverFor("shop.test"));

      await svc.storeScreenshot(job());
      await settle();

      expect(playwrightCaptures).toHaveLength(1);
      expect(playwrightCaptures[0]).toMatchObject({
        url: "https://shop.test/pricing",
        websiteId: SITE,
        norm: "/pricing",
      });
    });

    it("forces the capture, so the content hash cannot short-circuit it", async () => {
      // The tracker's html2canvas image is what got us here; the point of the
      // re-capture is to replace it with a real render.
      const svc = service(resolverFor("shop.test"));

      await svc.storeScreenshot(job());
      await settle();

      expect(playwrightCaptures[0]!.force).toBe(true);
    });

    it("captures once per path per lifecycle, however many images arrive", async () => {
      // The tracker re-sends the same page image on every session. Without the guard
      // this is one browser launch per visitor.
      const svc = service(resolverFor("shop.test"));

      await svc.storeScreenshot(job({ jpeg: jpeg(500, 1) }));
      await svc.storeScreenshot(job({ jpeg: jpeg(500, 2) }));
      await svc.storeScreenshot(job({ jpeg: jpeg(500, 3) }));
      await settle();

      expect(playwrightCaptures).toHaveLength(1);
    });

    it("still captures a different path on the same site", async () => {
      const svc = service(resolverFor("shop.test"));

      await svc.storeScreenshot(job({ url: "https://shop.test/pricing" }));
      await svc.storeScreenshot(job({ url: "https://shop.test/features" }));
      await settle();

      expect(playwrightCaptures.map((c) => c.norm)).toEqual(["/pricing", "/features"]);
    });

    it("treats two instances as separate lifecycles", async () => {
      // The guard is per-instance state, not a module-level set — so it does not
      // survive a restart, which is the intended scope.
      const websites = resolverFor("shop.test");

      await service(websites).storeScreenshot(job());
      await service(websites).storeScreenshot(job());
      await settle();

      expect(playwrightCaptures).toHaveLength(2);
    });

    it("marks the path as tried before the capture runs, not after", async () => {
      // Otherwise a burst arriving inside one flush all passes the check before the
      // first capture resolves.
      const svc = service(resolverFor("shop.test"));

      await Promise.all([
        svc.storeScreenshot(job({ jpeg: jpeg(500, 1) })),
        svc.storeScreenshot(job({ jpeg: jpeg(500, 2) })),
      ]);
      await settle();

      expect(playwrightCaptures).toHaveLength(1);
    });

    it("does not retry after a failed capture", async () => {
      playwrightThrows = true;
      const svc = service(resolverFor("shop.test"));

      await svc.storeScreenshot(job({ jpeg: jpeg(500, 1) }));
      await settle();
      await svc.storeScreenshot(job({ jpeg: jpeg(500, 2) }));
      await settle();

      expect(playwrightCaptures).toHaveLength(1);
    });

    it("keeps a failed capture from failing the ingest flush", async () => {
      // Fire-and-forget: no visitor's data waits on a browser, and a dead browser must
      // not reject the batch and cause a redelivery.
      playwrightThrows = true;
      const svc = service(resolverFor("shop.test"));

      await svc.storeScreenshot(job());
      await settle();

      expect(jpegPuts).toHaveLength(1);
      expect(jpegUpserts).toHaveLength(1);
    });

    it("stores the tracker image even though the capture is still in flight", async () => {
      const svc = service(resolverFor("shop.test"));

      await svc.storeScreenshot(job());

      // Asserted before `settle()`: the store path did not await the browser.
      expect(jpegUpserts).toHaveLength(1);
    });
  });

  describe("the capture target guard", () => {
    it("refuses to capture when there is no resolver to check the domain against", async () => {
      // Capturing unguarded here would be the SSRF the check exists to prevent, and
      // this path has no user to attribute the request to.
      await service(null).storeScreenshot(job());
      await settle();

      expect(playwrightCaptures).toEqual([]);
    });

    it("still stores the tracker image when it skipped the capture", async () => {
      await service(null).storeScreenshot(job());
      await settle();

      expect(jpegUpserts).toHaveLength(1);
    });

    it("refuses to capture for a website that no longer resolves", async () => {
      await service(unknownResolver).storeScreenshot(job());
      await settle();

      expect(playwrightCaptures).toEqual([]);
    });

    it("refuses a target off the site's registered domain", async () => {
      // The url arrived at a public endpoint. Without this check it is an arbitrary
      // outbound fetch whose render is readable afterwards through /layout-snapshot.
      await service(resolverFor("shop.test")).storeScreenshot(
        job({ url: "https://evil.test/steal" }),
      );
      await settle();

      expect(playwrightCaptures).toEqual([]);
    });

    it("refuses the cloud metadata endpoint", async () => {
      await service(resolverFor("169.254.169.254")).storeScreenshot(
        job({ url: "http://169.254.169.254/latest/meta-data/" }),
      );
      await settle();

      expect(playwrightCaptures).toEqual([]);
    });

    it("refuses loopback", async () => {
      await service(resolverFor("localhost")).storeScreenshot(
        job({ url: "http://localhost:5432/" }),
      );
      await settle();

      expect(playwrightCaptures).toEqual([]);
    });

    it("refuses a non-http scheme", async () => {
      await service(resolverFor("shop.test")).storeScreenshot(
        job({ url: "file:///etc/passwd" }),
      );
      await settle();

      expect(playwrightCaptures).toEqual([]);
    });

    it("allows a subdomain of the registered domain", async () => {
      await service(resolverFor("shop.test")).storeScreenshot(
        job({ url: "https://eu.shop.test/pricing" }),
      );
      await settle();

      expect(playwrightCaptures).toHaveLength(1);
    });

    it("resolves the website by the id on the job", async () => {
      const calls: string[] = [];

      await service(resolverFor("shop.test", calls)).storeScreenshot(job());
      await settle();

      expect(calls).toEqual([SITE]);
    });
  });
});

describe("SnapshotIngestService.storeDomSnapshot", () => {
  describe("what it refuses to store", () => {
    it("stores nothing when layout capture is off", async () => {
      await service().storeDomSnapshot(domEvent({ heatmapLayoutEnabled: false }));

      expect(htmlPuts).toEqual([]);
      expect(htmlUpserts).toEqual([]);
    });

    it("stores nothing without a website id", async () => {
      await service().storeDomSnapshot(domEvent({ websiteId: "" }));

      expect(htmlPuts).toEqual([]);
    });

    it("refuses a non-string html payload rather than coercing it", async () => {
      await service().storeDomSnapshot(domEvent({ data: { html: 12345 } }));

      expect(htmlPuts).toEqual([]);
    });

    it("refuses an event with no data at all", async () => {
      await service().storeDomSnapshot(domEvent({ data: undefined }));

      expect(htmlPuts).toEqual([]);
    });

    it("refuses html below the size floor", async () => {
      await service().storeDomSnapshot(domEvent({ data: { html: "x".repeat(99) } }));

      expect(htmlPuts).toEqual([]);
    });

    it("accepts html exactly at the size floor", async () => {
      await service().storeDomSnapshot(domEvent({ data: { html: "x".repeat(100) } }));

      expect(htmlPuts).toHaveLength(1);
    });

    it("never triggers a Playwright capture", async () => {
      // Only the JPEG path does. A DOM snapshot arriving for a fresh path must not be
      // a second way to make the server fetch a page.
      await service(resolverFor("shop.test")).storeDomSnapshot(domEvent());
      await settle();

      expect(playwrightCaptures).toEqual([]);
    });
  });

  describe("storing", () => {
    it("uploads the html and records the row", async () => {
      const html = "<html>".padEnd(200, "y") + "</html>";

      await service().storeDomSnapshot(domEvent({ data: { html } }));

      expect(htmlPuts).toHaveLength(1);
      expect(htmlPuts[0]!.body).toBe(html);
      expect(htmlUpserts[0]).toMatchObject({
        websiteId: SITE,
        pagePath: "/pricing",
        sha: sha256(html),
      });
    });

    it("records the row against the key it uploaded to", async () => {
      await service().storeDomSnapshot(domEvent());

      expect(htmlUpserts[0]!.key).toBe(htmlPuts[0]!.key);
    });

    it("stores html under a different key from the jpeg for the same page", async () => {
      // Same path prefix, different extension. Sharing one key would have the JPEG and
      // the HTML overwrite each other.
      await service().storeScreenshot(job());
      await service().storeDomSnapshot(domEvent());

      expect(htmlPuts[0]!.key).not.toBe(jpegPuts[0]!.key);
      expect(htmlPuts[0]!.key).toEndWith(".html");
      expect(jpegPuts[0]!.key).toEndWith(".jpg");
    });

    it("normalizes the path", async () => {
      await service().storeDomSnapshot(domEvent({ url: "https://shop.test/orders/902133" }));

      expect(htmlUpserts[0]!.pagePath).toBe("/orders/:id");
    });

    it("treats a missing url as the root path", async () => {
      await service().storeDomSnapshot(domEvent({ url: undefined }));

      expect(htmlUpserts[0]!.pagePath).toBe("/");
    });

    it("does not write the row when the upload failed", async () => {
      putThrows = true;

      await expect(service().storeDomSnapshot(domEvent())).rejects.toThrow("s3 unreachable");
      expect(htmlUpserts).toEqual([]);
    });
  });

  describe("deduplication", () => {
    it("skips an unchanged snapshot that is already stored as html", async () => {
      const html = "<html>".padEnd(200, "z") + "</html>";
      storedRows.set(`${SITE}:/pricing`, row({
        content_sha256: sha256(html),
        html_s3_key: "heatmap-screenshots/site/slot.html",
      }));

      await service().storeDomSnapshot(domEvent({ data: { html } }));

      expect(htmlPuts).toEqual([]);
      expect(htmlUpserts).toEqual([]);
    });

    it("still writes html for a row with a matching hash but no html key", async () => {
      // The subtle case, and the reason the condition is two-part: that row is a
      // JPEG-only snapshot whose hash happens to match. Skipping on the hash alone
      // leaves the page permanently without a DOM snapshot.
      const html = "<html>".padEnd(200, "z") + "</html>";
      storedRows.set(`${SITE}:/pricing`, row({
        content_sha256: sha256(html),
        html_s3_key: null,
      }));

      await service().storeDomSnapshot(domEvent({ data: { html } }));

      expect(htmlPuts).toHaveLength(1);
    });

    it("writes when the stored hash differs, html key or not", async () => {
      storedRows.set(`${SITE}:/pricing`, row({
        content_sha256: "an-older-dom",
        html_s3_key: "heatmap-screenshots/site/slot.html",
      }));

      await service().storeDomSnapshot(domEvent());

      expect(htmlPuts).toHaveLength(1);
    });

    it("does not consult the in-process jpeg hash cache", async () => {
      // That cache holds image hashes. Reusing it here would compare an HTML digest
      // against a JPEG digest — never equal, but it would also mean a JPEG upload
      // could suppress an HTML one if the layering were ever shared.
      const html = "<html>".padEnd(200, "z") + "</html>";
      cachedHashes.set(`${SITE}:/pricing`, sha256(html));

      await service().storeDomSnapshot(domEvent({ data: { html } }));

      expect(htmlPuts).toHaveLength(1);
    });
  });

  describe("document dimensions", () => {
    it("keeps plausible dimensions", async () => {
      await service().storeDomSnapshot(domEvent({ docW: 1440, docH: 3000 }));

      expect(htmlUpserts[0]).toMatchObject({ w: 1440, h: 3000 });
    });

    it("falls back for absent dimensions, which are routine here", async () => {
      await service().storeDomSnapshot(domEvent({ docW: undefined, docH: undefined }));

      expect(htmlUpserts[0]).toMatchObject({ w: 1280, h: 800 });
    });

    it("falls back below the plausibility floor", async () => {
      await service().storeDomSnapshot(domEvent({ docW: 10, docH: 10 }));

      expect(htmlUpserts[0]).toMatchObject({ w: 1280, h: 800 });
    });
  });
});
