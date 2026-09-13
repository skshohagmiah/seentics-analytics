import { describe, it, expect, beforeEach } from "bun:test";
import type { AnalyticsPageviewUrls } from "../../analytics/interfaces";
import { HeatmapAutoCapture } from "../services/heatmap-auto-capture.service";

/**
 * The pageview-URL fallback used to be the only database reach in this file's graph,
 * stubbed with `mock.module` before importing the module under test. It is now an
 * injected port, so a plain object does the job — which also removes the
 * process-global `mock.module` call and the deferred import it forced.
 */
const recentPageviewUrls: string[] = [];
const pageviewUrls: AnalyticsPageviewUrls = {
  async listRecentPageviewUrls() {
    return recentPageviewUrls;
  },
};
type CaptureCall = {
  websiteId: string;
  pagePath: string;
  pageUrl: string;
  force: boolean;
};

const RESOLVED = {
  websiteId: "11111111-1111-4111-8111-111111111111",
  siteUrl: "one.example",
};

/** Lets a test hold a capture open, which is how the in-flight guard is observable. */
function makeCapture() {
  const calls: CaptureCall[] = [];
  let release: (() => void) | null = null;
  let shouldThrow = false;

  const capture = async (
    resolved: typeof RESOLVED,
    request: { pageUrl: string; pagePath: string; force?: boolean },
  ) => {
    calls.push({
      websiteId: resolved.websiteId,
      pagePath: request.pagePath,
      pageUrl: request.pageUrl,
      force: request.force ?? false,
    });
    if (shouldThrow) throw new Error("page would not load");
    if (release) await new Promise<void>((r) => (release = r));
    return { success: true, stored: true };
  };

  return {
    capture,
    calls,
    hold() {
      release = () => {};
    },
    letGo() {
      const r = release;
      release = null;
      r?.();
    },
    setThrowing(v: boolean) {
      shouldThrow = v;
    },
  };
}

/** `schedule` is fire-and-forget, so tests need a microtask drain to observe it. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("HeatmapAutoCapture", () => {
  let cap: ReturnType<typeof makeCapture>;
  let autoCapture: InstanceType<typeof HeatmapAutoCapture>;

  beforeEach(() => {
    recentPageviewUrls.length = 0;
    cap = makeCapture();
    autoCapture = new HeatmapAutoCapture(cap.capture, pageviewUrls);
  });

  describe("scheduling", () => {
    it("returns immediately rather than awaiting the capture", () => {
      // A ten-second headless-browser launch must not be on the request path.
      const returned = autoCapture.schedule(RESOLVED, "/pricing");
      expect(returned).toBeUndefined();
    });

    it("captures using a URL built from the registered domain", async () => {
      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();

      expect(cap.calls).toHaveLength(1);
      expect(cap.calls[0]?.pageUrl).toContain("one.example");
      expect(cap.calls[0]?.pagePath).toBe("/pricing");
    });

    it("passes the resolved UUID through, never the websiteId", async () => {
      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();

      expect(cap.calls[0]?.websiteId).toBe(RESOLVED.websiteId);
    });

    it("defaults force to false", async () => {
      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();

      expect(cap.calls[0]?.force).toBe(false);
    });

    // A stale image still matches its own content hash, so a refresh has to bypass
    // the dedup shortcut or it would be a no-op.
    it("forwards force for a stale refresh", async () => {
      autoCapture.schedule(RESOLVED, "/pricing", true);
      await settle();

      expect(cap.calls[0]?.force).toBe(true);
    });
  });

  /**
   * The load-bearing behaviour. A dashboard polling a page with no snapshot would
   * otherwise launch one headless browser per poll, and Playwright under
   * concurrency exhausts container memory long before it exhausts the queue.
   */
  describe("in-flight deduplication", () => {
    it("skips a second capture for the same page while the first runs", async () => {
      cap.hold();

      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();
      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();

      expect(cap.calls).toHaveLength(1);
      cap.letGo();
    });

    it("allows a different page concurrently", async () => {
      cap.hold();

      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();
      autoCapture.schedule(RESOLVED, "/docs");
      await settle();

      expect(cap.calls.map((c) => c.pagePath)).toEqual(["/pricing", "/docs"]);
      cap.letGo();
    });

    // The key is `websiteId:path`, so the same path on two sites must not collide.
    it("allows the same path on a different website", async () => {
      cap.hold();
      const other = { ...RESOLVED, websiteId: "22222222-2222-4222-8222-222222222222" };

      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();
      autoCapture.schedule(other, "/pricing");
      await settle();

      expect(cap.calls).toHaveLength(2);
      cap.letGo();
    });

    it("permits a retry once the first capture finishes", async () => {
      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();
      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();

      expect(cap.calls).toHaveLength(2);
    });

    // Without the `finally` that clears the set, one failed capture would block
    // that page from ever being retried for the process's lifetime.
    it("clears the in-flight key after a failure", async () => {
      cap.setThrowing(true);
      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();

      cap.setThrowing(false);
      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();

      expect(cap.calls).toHaveLength(2);
    });
  });

  describe("page URL resolution", () => {
    // Preferred because it needs no query and is the domain the tracker validates.
    it("prefers the registered domain over scanning pageviews", async () => {
      recentPageviewUrls.push("https://other.example/pricing");
      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();

      expect(cap.calls[0]?.pageUrl).toContain("one.example");
    });

    it("falls back to a real pageview URL when the site url is blank", async () => {
      recentPageviewUrls.push("https://one.example/pricing?ref=x");
      autoCapture.schedule({ ...RESOLVED, siteUrl: "" }, "/pricing");
      await settle();

      expect(cap.calls).toHaveLength(1);
      expect(cap.calls[0]?.pageUrl).toBe("https://one.example/pricing?ref=x");
    });

    it("does not capture when no URL can be found", async () => {
      autoCapture.schedule({ ...RESOLVED, siteUrl: "" }, "/pricing");
      await settle();

      expect(cap.calls).toHaveLength(0);
    });

    it("ignores pageview URLs whose path does not match", async () => {
      recentPageviewUrls.push("https://one.example/docs", "https://one.example/about");
      autoCapture.schedule({ ...RESOLVED, siteUrl: "" }, "/pricing");
      await settle();

      expect(cap.calls).toHaveLength(0);
    });
  });

  // A page that will not load is routine — expired links, auth walls, pages that
  // 404 since the visit. `schedule` is fire-and-forget, so a throw that escaped
  // would surface as an unhandled rejection and take the process down.
  describe("failure containment", () => {
    it("attempts the capture and swallows the failure", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown) => unhandled.push(e);
      process.on("unhandledRejection", onUnhandled);

      cap.setThrowing(true);
      autoCapture.schedule(RESOLVED, "/pricing");
      await settle();

      process.off("unhandledRejection", onUnhandled);

      expect(cap.calls).toHaveLength(1);
      expect(unhandled).toEqual([]);
    });
  });
});
