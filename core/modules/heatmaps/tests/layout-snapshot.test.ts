import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { testConfig } from "../../../app/tests/helpers/test-config";
import type { LayoutSnapshotRow } from "../lib/layout-db";
import type { ResolvedWebsite } from "../interfaces";

/**
 * The dashboard's own screenshot path, and the read that serves it back.
 *
 * `decodeJpegUpload`'s rejection messages are a contract, not diagnostics: the route
 * returns `String(e)` straight to the client, so each one is what a user sees when their
 * html2canvas render is refused.
 *
 * `storeDashboardScreenshot` is where a reachable bug lived. `/save-screenshot` coerces
 * with `Number(body.doc_width)`, which is `NaN` for any non-numeric field, and the
 * plausibility guard was written as `dW < MIN` — a comparison that is *false* for NaN.
 * So the fallback was skipped for precisely the input that could not be stored, and NaN
 * reached an integer column. The dimension tests below are the regression.
 */

process.env.DATABASE_URL ??= "postgres://test-not-connected";

mock.module("../../../config", () => ({ env: () => testConfig() }));

/** Rows `getLayoutSnapshot` should report, keyed `websiteId:pagePath`. */
const storedRows = new Map<string, LayoutSnapshotRow>();
/** Every `upsertLayoutSnapshot` call, in order. */
const upserts: {
  websiteId: string;
  pagePath: string;
  device: string;
  key: string;
  sha: string;
  w: number;
  h: number;
}[] = [];

mock.module("../lib/layout-db", () => ({
  getCachedSnapshotSha256: () => null,
  getLayoutSnapshot: async (websiteId: string, pagePath: string) =>
    storedRows.get(`${websiteId}:${pagePath}`) ?? null,
  upsertLayoutSnapshot: async (
    websiteId: string,
    pagePath: string,
    device: string,
    key: string,
    sha: string,
    w: number,
    h: number,
  ) => {
    upserts.push({ websiteId, pagePath, device, key, sha, w, h });
  },
  upsertLayoutHtmlSnapshot: async () => {},
}));

const jpegPuts: { key: string; bytes: number }[] = [];

mock.module("../../../platform/lib/s3", () => ({
  s3: () => ({}),
  putJpeg: async (_bucket: string, key: string, body: Uint8Array) => {
    jpegPuts.push({ key, bytes: body.length });
  },
  putHtml: async () => {},
  deleteS3Objects: async () => {},
  getNextReplayChunkSequence: async () => 0,
  uploadSessionChunkGzip: async () => {},
  deleteSessionPrefix: async () => {},
  listSessionReplayChunks: async () => [],
  presignGet: async (_bucket: string, key: string) => `https://signed.test/${key}`,
  locateBundle: async () => null,
  getJsonGzip: async () => [],
}));

const { decodeJpegUpload, readLayoutSnapshot, storeDashboardScreenshot } = await import(
  "../services/layout-snapshot.service"
);

const SITE = "11111111-1111-4111-8111-111111111111";

const RESOLVED: ResolvedWebsite = { websiteId: SITE, siteUrl: "shop.test" };

/** A buffer that passes the JPEG magic-byte check. */
function jpegBuffer(bytes = 1000): Buffer {
  const b = Buffer.alloc(bytes, 1);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
}

/** The same buffer as a base64 payload, optionally with a data-URI prefix. */
function jpegBase64(opts: { prefix?: boolean; bytes?: number } = {}): string {
  const raw = jpegBuffer(opts.bytes ?? 1000).toString("base64");
  return opts.prefix ? `data:image/jpeg;base64,${raw}` : raw;
}

function row(over: Partial<LayoutSnapshotRow> = {}): LayoutSnapshotRow {
  return {
    page_path: "/pricing",
    s3_key: "heatmap-screenshots/site/slot.jpg",
    content_sha256: "hash",
    doc_width: 1440,
    doc_height: 3000,
    html_s3_key: null,
    device_type: "desktop",
    updated_at: new Date("2026-09-01T00:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  storedRows.clear();
  upserts.length = 0;
  jpegPuts.length = 0;
});

describe("decodeJpegUpload", () => {
  it("accepts a bare base64 payload", () => {
    const out = decodeJpegUpload(jpegBase64());

    expect(out.length).toBe(1000);
  });

  it("strips a data-URI prefix", () => {
    const out = decodeJpegUpload(jpegBase64({ prefix: true }));

    expect(out.length).toBe(1000);
  });

  it("rejects an empty payload", () => {
    // Each message below is what the user sees: the route answers `String(e)`.
    expect(() => decodeJpegUpload("")).toThrow();
  });

  it("rejects a payload that decodes to something other than a JPEG", () => {
    const notJpeg = Buffer.alloc(1000, 7).toString("base64");

    expect(() => decodeJpegUpload(notJpeg)).toThrow(/JPEG/i);
  });

  it("rejects a payload below the 400-byte floor", () => {
    const tiny = jpegBuffer(399).toString("base64");

    expect(() => decodeJpegUpload(tiny)).toThrow(/size out of range/);
  });

  it("accepts a payload exactly at the floor", () => {
    expect(decodeJpegUpload(jpegBuffer(400).toString("base64")).length).toBe(400);
  });

  it("rejects a payload above the 10 MiB ceiling", () => {
    // Deliberately a *different* ceiling from the tracker path's 4 MiB in
    // `point-mapping`. The dashboard's html2canvas render of a long page is
    // legitimately larger than anything the tracker should ever send, and the two
    // limits are set from opposite directions — so a change that unifies them is a
    // decision, not a cleanup, and should fail one of these two tests.
    const huge = jpegBuffer(10 * 1024 * 1024 + 1).toString("base64");

    expect(() => decodeJpegUpload(huge)).toThrow(/size out of range/);
  });

  it("accepts a payload exactly at the ceiling", () => {
    const atLimit = jpegBuffer(10 * 1024 * 1024).toString("base64");

    expect(decodeJpegUpload(atLimit).length).toBe(10 * 1024 * 1024);
  });

  it("reports the offending size, so the user can see how far over they are", () => {
    // The route answers `String(e)`, so this number is the whole diagnostic.
    expect(() => decodeJpegUpload(jpegBuffer(399).toString("base64"))).toThrow(/399 bytes/);
  });

  it("checks the size before the magic bytes", () => {
    // A truncated upload is a size problem, and saying "not a valid JPEG" for it sends
    // the user looking at their image format instead of their upload.
    const tinyNotJpeg = Buffer.alloc(10, 7).toString("base64");

    expect(() => decodeJpegUpload(tinyNotJpeg)).toThrow(/size out of range/);
  });
});

describe("storeDashboardScreenshot", () => {
  it("uploads the image and points the row at the key it wrote", async () => {
    const jpeg = jpegBuffer();

    const key = await storeDashboardScreenshot(RESOLVED, "/pricing", jpeg, 1440, 3000);

    expect(jpegPuts).toHaveLength(1);
    expect(key).toBe(jpegPuts[0]!.key);
    expect(upserts[0]).toMatchObject({
      websiteId: SITE,
      pagePath: "/pricing",
      key,
      sha: createHash("sha256").update(jpeg).digest("hex"),
    });
  });

  it("keys the S3 object and the row by the same website identifier", async () => {
    // The two ids in this domain are both strings and a mix-up is invisible to the
    // compiler — an object stored under one and a row keyed by the other reads as a
    // snapshot that exists and 404s.
    await storeDashboardScreenshot(RESOLVED, "/pricing", jpegBuffer(), 1440, 3000);

    expect(jpegPuts[0]!.key).toContain(SITE);
    expect(upserts[0]!.websiteId).toBe(SITE);
  });

  describe("document dimensions", () => {
    it("keeps plausible dimensions", async () => {
      await storeDashboardScreenshot(RESOLVED, "/p", jpegBuffer(), 1440, 3000);

      expect(upserts[0]).toMatchObject({ w: 1440, h: 3000 });
    });

    it("falls back for a zero dimension, which html2canvas reports for an unmeasurable page", async () => {
      await storeDashboardScreenshot(RESOLVED, "/p", jpegBuffer(), 0, 0);

      expect(upserts[0]).toMatchObject({ w: 1280, h: 800 });
    });

    it("falls back below the plausibility floor", async () => {
      await storeDashboardScreenshot(RESOLVED, "/p", jpegBuffer(), 199, 199);

      expect(upserts[0]).toMatchObject({ w: 1280, h: 800 });
    });

    it("keeps a dimension exactly at the floor", async () => {
      await storeDashboardScreenshot(RESOLVED, "/p", jpegBuffer(), 200, 200);

      expect(upserts[0]).toMatchObject({ w: 200, h: 200 });
    });

    it("falls back for NaN rather than writing it to an integer column", async () => {
      // The regression. `/save-screenshot` builds these with `Number(body.doc_width)`,
      // so any non-numeric field arrives as NaN — and `NaN < 200` is false, which meant
      // the fallback was skipped for exactly this input.
      await storeDashboardScreenshot(RESOLVED, "/p", jpegBuffer(), Number.NaN, Number.NaN);

      expect(upserts[0]).toMatchObject({ w: 1280, h: 800 });
    });

    it("falls back for an infinite dimension", async () => {
      await storeDashboardScreenshot(
        RESOLVED,
        "/p",
        jpegBuffer(),
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      );

      expect(upserts[0]).toMatchObject({ w: 1280, h: 800 });
    });

    it("stores an integer for every dimension it accepts", async () => {
      // The columns are integers. This is the property the two guards above exist to
      // maintain, asserted directly rather than case by case.
      const inputs: [number, number][] = [
        [1440, 3000],
        [0, 0],
        [199.9, 200.9],
        [-5, -5],
        [Number.NaN, Number.NaN],
        [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      ];

      for (const [w, h] of inputs) {
        upserts.length = 0;
        await storeDashboardScreenshot(RESOLVED, "/p", jpegBuffer(), w, h);

        expect(Number.isInteger(upserts[0]!.w)).toBe(true);
        expect(Number.isInteger(upserts[0]!.h)).toBe(true);
      }
    });

    it("truncates a fractional dimension rather than storing a float", async () => {
      await storeDashboardScreenshot(RESOLVED, "/p", jpegBuffer(), 1440.9, 3000.9);

      expect(upserts[0]).toMatchObject({ w: 1440, h: 3000 });
    });
  });
});

describe("readLayoutSnapshot", () => {
  /** Takes the website UUID directly — the caller normalizes the path before this. */
  const read = (path: string) => readLayoutSnapshot(SITE, path);

  it("reports a miss when the page has no snapshot row", async () => {
    // A miss is routine, not an error: it triggers a background capture and the
    // dashboard draws points with no backdrop until the next poll.
    const out = await read("/pricing");

    expect(out).toMatchObject({ layout: null, missing: true, stale: false });
  });

  it("counts a row with neither object stored as a miss", async () => {
    storedRows.set(`${SITE}:/pricing`, row({ s3_key: "", html_s3_key: null }));

    const out = await read("/pricing");

    expect(out.missing).toBe(true);
  });

  it("counts an html-only row as present, not a miss", async () => {
    // `upsertLayoutHtmlSnapshot` inserts with `s3_key=''`. Checking only `s3_key`
    // would treat a perfectly good DOM snapshot as missing and hide it behind an
    // unnecessary Playwright capture.
    storedRows.set(`${SITE}:/pricing`, row({ s3_key: "", html_s3_key: "site/slot.html" }));

    const out = await read("/pricing");

    expect(out.missing).toBe(false);
    expect(out.layout?.html_url).toContain("slot.html");
  });

  it("omits the image url for an html-only row rather than presigning an empty key", async () => {
    storedRows.set(`${SITE}:/pricing`, row({ s3_key: "", html_s3_key: "site/slot.html" }));

    const out = await read("/pricing");

    expect(out.layout?.image_url).toBeUndefined();
  });

  it("presigns the stored image and states when the URL expires", async () => {
    // The expiry is part of the contract, not a hint — the client refetches rather
    // than caching, so an expiry it cannot see is an image that silently starts 403ing.
    storedRows.set(`${SITE}:/pricing`, row());

    const out = await read("/pricing");

    expect(out.layout?.image_url).toContain("https://signed.test/");
    expect(Date.parse(out.layout!.image_url_expires_at)).toBeGreaterThan(Date.now());
  });

  it("carries the stored document dimensions through", async () => {
    storedRows.set(`${SITE}:/pricing`, row({ doc_width: 1024, doc_height: 2048 }));

    const out = await read("/pricing");

    expect(out.layout).toMatchObject({ doc_width: 1024, doc_height: 2048 });
  });

  it("presigns the html snapshot when the row has one", async () => {
    storedRows.set(`${SITE}:/pricing`, row({ html_s3_key: "heatmap/site/slot.html" }));

    const out = await read("/pricing");

    expect(out.layout?.html_url).toContain("slot.html");
    expect(out.layout?.html_url_expires_at).toBeTruthy();
  });

  it("omits the html expiry when there is no html url", async () => {
    // Not just the url: an expiry alongside an absent url would have the client wait
    // for a refresh of something it never received.
    storedRows.set(`${SITE}:/pricing`, row({ html_s3_key: null }));

    const out = await read("/pricing");

    expect(out.layout?.html_url).toBeUndefined();
    expect(out.layout?.html_url_expires_at).toBeUndefined();
  });

  it("reports a fresh row as not stale", async () => {
    storedRows.set(`${SITE}:/pricing`, row({ updated_at: new Date() }));

    const out = await read("/pricing");

    expect(out.stale).toBe(false);
  });

  it("reports a row past three days as stale", async () => {
    // Stale is reported, not acted on: the caller returns the old pixels while a
    // refresh runs behind them, because three-day-old pixels beat none.
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    storedRows.set(`${SITE}:/pricing`, row({ updated_at: fourDaysAgo }));

    const out = await read("/pricing");

    expect(out.stale).toBe(true);
    expect(out.layout).not.toBeNull();
  });

  it("still returns the layout for a stale row", async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    storedRows.set(`${SITE}:/pricing`, row({ updated_at: old }));

    const out = await read("/pricing");

    expect(out.layout?.image_url).toBeTruthy();
  });

  it("treats a row just inside the window as fresh", async () => {
    const almost = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000 - 60_000));
    storedRows.set(`${SITE}:/pricing`, row({ updated_at: almost }));

    const out = await read("/pricing");

    expect(out.stale).toBe(false);
  });

  it("looks the path up verbatim, leaving normalization to the caller", async () => {
    // Pinning the seam: this function does no path handling, so a caller that forgets
    // to normalize gets a miss rather than a wrong page's backdrop.
    storedRows.set(`${SITE}:/orders/:id`, row({ page_path: "/orders/:id" }));

    expect((await read("/orders/8213")).missing).toBe(true);
    expect((await read("/orders/:id")).missing).toBe(false);
  });
});
