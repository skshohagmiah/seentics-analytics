import { describe, it, expect, beforeEach, mock } from "bun:test";

process.env.DATABASE_URL ??= "postgres://test-not-connected";

/**
 * The capture target guard.
 *
 * Capture is the one capability in the product that makes the server fetch a URL the
 * caller chose, and the rendered result is stored and readable afterwards through
 * `/layout-snapshot` — so an unchecked target is not a request, it is exfiltration.
 *
 * `validateScreenshotTargetUrl` was correct and well tested, but only two of the three
 * entry points called it. The two authenticated dashboard routes passed `page_url`
 * straight through to Playwright, and registration is open, so an account was the only
 * prerequisite for pointing the browser at cloud metadata or an internal service. The
 * check now lives in `captureForResolved`, which every path funnels through, and this
 * file pins that.
 *
 * Note what the refusal cases do *not* need: no stub for the browser or the database,
 * because a refused target must never reach either. Only the accepted case does.
 */

const captured: string[] = [];
let captureResult: unknown = {
  s3Key: "sites/w1/pages/home.jpg",
  hash: "abc",
  width: 1920,
  height: 1080,
  sizeBytes: 1000,
  stored: true,
};

/**
 * Both stubs list **every** runtime export of the module they replace, not just the ones
 * this file calls.
 *
 * Bun applies `mock.module` to the whole run, so a partial stub becomes the module for
 * every other file too — omitting `getCachedSnapshotSha256` here broke
 * `point-scaling.test.ts`, which never mentions layout snapshots, with a
 * `SyntaxError: Export named ... not found` pointing at the real file that does export
 * it. Same rule as `app/tests/helpers/test-config.ts`.
 */
mock.module("../lib/playwright-screenshots", () => ({
  captureAndStoreScreenshot: async (pageUrl: string) => {
    captured.push(pageUrl);
    return captureResult;
  },
  shutdownScreenshotBrowser: async () => {},
}));

const snapshots: string[] = [];
mock.module("../lib/layout-db", () => ({
  upsertLayoutSnapshot: async (_websiteId: string, pagePath: string) => {
    snapshots.push(pagePath);
  },
  upsertLayoutHtmlSnapshot: async () => {},
  getLayoutSnapshot: async () => null,
  getCachedSnapshotSha256: () => null,
}));

const { HeatmapScreenshotService } = await import("../services/playwright-screenshot-capture.service");
const { ScreenshotTargetNotAllowedError } = await import("../interfaces");

const SITE = "one.example";
const RESOLVED = { websiteId: "11111111-1111-4111-8111-111111111111", siteUrl: SITE };

const settings = {
  async getCaptureTarget(ref: string) {
    return ref === "unknown" ? null : { ...RESOLVED, layoutEnabled: true };
  },
};

let service: InstanceType<typeof HeatmapScreenshotService>;

beforeEach(() => {
  captured.length = 0;
  snapshots.length = 0;
  captureResult = {
    s3Key: "sites/w1/pages/home.jpg",
    hash: "abc",
    width: 1920,
    height: 1080,
    sizeBytes: 1000,
    stored: true,
  };
  service = new HeatmapScreenshotService(settings as never);
});

function capture(pageUrl: string) {
  return service.capture("w1", { pageUrl, pagePath: "/p" } as never);
}

describe("targets that must be refused", () => {
  /**
   * Each of these was accepted before the guard moved into the service, on an endpoint
   * reachable with any account.
   */
  const FORBIDDEN: [string, string][] = [
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:8080/admin"],
    ["localhost by name", "http://localhost:5432/"],
    ["the docker host", "http://host.docker.internal:9000/"],
    ["a private range address", "http://192.168.1.10/"],
    ["another private range", "http://10.0.0.5/internal"],
    ["an IPv6 literal", "http://[::1]/"],
    ["an unrelated public domain", "https://evil.example/steal"],
    ["a lookalike domain", "https://one.example.evil.com/"],
    ["a non-http scheme", "file:///etc/passwd"],
    ["a nonsense url", "not-a-url"],
  ];

  for (const [label, url] of FORBIDDEN) {
    it(`refuses ${label}`, async () => {
      expect(capture(url)).rejects.toThrow(ScreenshotTargetNotAllowedError);
    });
  }

  it("never launches the browser for a refused target", async () => {
    await capture("http://169.254.169.254/latest/meta-data/").catch(() => {});
    expect(captured).toEqual([]);
  });

  it("never records a layout snapshot for a refused target", async () => {
    await capture("http://127.0.0.1/admin").catch(() => {});
    expect(snapshots).toEqual([]);
  });

  it("stores nothing for a capture that did not happen", async () => {
    await capture("https://evil.example/").catch(() => {});
    expect(snapshots).toEqual([]);
  });

  /**
   * The batch endpoint reports per-item failures rather than throwing, so a refused
   * target there must fail its own item and leave the rest alone.
   */
  it("fails only the offending item in a batch", async () => {
    const results = await service.captureBatch("w1", [
      { pageUrl: `https://${SITE}/ok`, pagePath: "/ok" },
      { pageUrl: "http://169.254.169.254/", pagePath: "/evil" },
    ] as never);

    expect(results.map((r) => r.success)).toEqual([true, false]);
    expect(results[1]!.error).toContain("not allowed");
    expect(captured).toEqual([`https://${SITE}/ok`]);
  });
});

describe("targets that must be allowed", () => {
  it("accepts the site's own domain", async () => {
    await capture(`https://${SITE}/pricing`);
    expect(captured).toEqual([`https://${SITE}/pricing`]);
  });

  it("accepts a subdomain of it", async () => {
    await capture(`https://blog.${SITE}/post`);
    expect(captured).toEqual([`https://blog.${SITE}/post`]);
  });

  it("accepts www, which is stripped on both sides", async () => {
    await capture(`https://www.${SITE}/`);
    expect(captured).toHaveLength(1);
  });

  it("accepts plain http", async () => {
    await capture(`http://${SITE}/`);
    expect(captured).toHaveLength(1);
  });

  it("records the snapshot for a capture that stored an image", async () => {
    await capture(`https://${SITE}/pricing`);
    expect(snapshots).toEqual(["/p"]);
  });
});

describe("an unresolvable website", () => {
  it("is refused before any target check", async () => {
    expect(
      service.capture("unknown", { pageUrl: `https://${SITE}/`, pagePath: "/p" } as never),
    ).rejects.toThrow("Website not found");
    expect(captured).toEqual([]);
  });
});
