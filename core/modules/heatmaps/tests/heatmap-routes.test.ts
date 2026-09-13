import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context, Next } from "hono";
import type { Website, WebsiteQuery, WebsiteRole } from "../../websites/interfaces";
import type {
  BatchCaptureScreenshotResult,
  CaptureScreenshotRequest,
  CaptureScreenshotResult,
  HeatmapLayout,
  HeatmapPageSummary,
  HeatmapPointOut,
} from "../interfaces";

/**
 * The heatmaps HTTP surface declared in `routes.ts`, including capture endpoints.
 *
 * This module had no route tests at all, which is the wrong place for that gap: two of
 * these endpoints make the server fetch a caller-chosen URL with a real browser and store
 * the render where `/layout-snapshot` will hand it back. Three properties of that are
 * behaviour rather than implementation detail, and none of them is expressible in a type:
 *
 * - Every route goes through `guarded`, and an unknown website answers **403, not 404**.
 *   A 404 would turn the endpoint into an oracle for which site ids exist, and
 *   registration is open.
 * - A *refused* capture target is a 403 and an *unreachable* one is a 400. Collapsing
 *   them loses the only signal that tells a caller "this URL is off-limits" apart from
 *   "this URL was down", and the refusal is the SSRF guard's only visible output.
 * - The capture endpoints coerce rather than reject — a missing viewport means "use the
 *   default". So the defaults are part of the contract, and a change to them is invisible
 *   until it reaches Playwright.
 *
 * `screenshots` and `heatmaps` arrive as injected fakes because `createHeatmapRoutes` is
 * a factory; the real services never load. `playwright-screenshots` and `layout-db` are
 * stubbed only because the capture controller imports the error class from
 * `playwright-screenshot-capture.service`, which reaches both transitively — and `layout-db` opens `db` at
 * module scope.
 */

process.env.DATABASE_URL ??= "postgres://test-not-connected";

mock.module("../../../platform/middleware/auth", () => ({
  authMiddleware: async (c: Context<{ Variables: { userId: string } }>, next: Next) => {
    const userId = c.req.header("X-Test-User");
    if (!userId) return c.json({ error: "Authorization required" }, 401);
    c.set("userId", userId);
    return next();
  },
  requireUser: (c: Context<{ Variables: { userId: string } }>) => c.get("userId") ?? null,
}));

/**
 * Both stubs list every runtime export of the module they replace, not just the names
 * this file reaches — see `app/tests/mock-completeness.test.ts`. Neither is exercised
 * here; they exist so the import graph of `../routes` stops short of a browser and a
 * database connection.
 */
mock.module("../lib/playwright-screenshots", () => ({
  captureAndStoreScreenshot: async () => ({
    s3Key: "unused",
    hash: "unused",
    width: 0,
    height: 0,
    sizeBytes: 0,
    stored: false,
  }),
  shutdownScreenshotBrowser: async () => {},
}));

mock.module("../lib/layout-db", () => ({
  upsertLayoutSnapshot: async () => {},
  upsertLayoutHtmlSnapshot: async () => {},
  getLayoutSnapshot: async () => null,
  getCachedSnapshotSha256: () => null,
}));

const { createHeatmapRoutes } = await import("../routes");
const { ScreenshotTargetNotAllowedError } = await import("../interfaces");

const WEBSITE = "11111111-1111-4111-8111-111111111111";
const OTHER_WEBSITE = "22222222-2222-4222-8222-222222222222";

/** One user per role, so a test can pick the least-privileged caller that should pass. */
const USERS: Record<string, WebsiteRole> = {
  u_owner: "owner",
  u_admin: "admin",
  u_member: "member",
  u_viewer: "viewer",
};

class FakeWebsites implements WebsiteQuery {
  roleCalls: { websiteRef: string; userId: string }[] = [];

  async getById(): Promise<Website | null> {
    return { id: WEBSITE } as Website;
  }
  async listOwnedBy(): Promise<Website[]> {
    return [];
  }
  async getRole(websiteRef: string, userId: string): Promise<WebsiteRole | null> {
    this.roleCalls.push({ websiteRef, userId });
    // Only `WEBSITE` is known. `OTHER_WEBSITE` stands in for a site id the caller
    // guessed — indistinguishable from a real one they cannot see, by design.
    if (websiteRef !== WEBSITE) return null;
    return USERS[userId] ?? null;
  }
}

const PAGE: HeatmapPageSummary = {
  page_path: "/pricing",
  click_count: 412,
  scroll_count: 91,
  avg_scroll: 63,
  last_seen: "2026-09-01T00:00:00.000Z",
};

const POINT: HeatmapPointOut = {
  page_path: "/orders/:id",
  event_type: "click",
  device_type: "desktop",
  // Stored at 10000x — see `tests/point-scaling.test.ts` for why these are not percents.
  x_percent: 5000,
  y_percent: 2500,
  intensity: 3,
  target_selector: "#buy",
};

const LAYOUT: HeatmapLayout = {
  image_url: "https://signed.test/shot.jpg",
  image_url_expires_at: "2026-09-01T01:00:00.000Z",
  doc_width: 1920,
  doc_height: 4200,
  device_type: "desktop",
  device_fallback: false,
};

/** Records every call, so a test can assert a refused request never reached the service. */
class FakeHeatmaps {
  listPagesCalls: string[] = [];
  pointCalls: { ref: string; path: string; type: string }[] = [];
  snapshotCalls: { ref: string; path: string }[] = [];
  saveCalls: { ref: string; path: string; image: string; w: number; h: number }[] = [];
  deleteCalls: { ref: string; paths: string[] }[] = [];

  /** When set, `saveDashboardScreenshot` throws it — the service's message is the 400 body. */
  saveThrows: Error | null = null;

  async listPages(websiteRef: string) {
    this.listPagesCalls.push(websiteRef);
    return { pages: [PAGE] };
  }

  async getPoints(websiteRef: string, pagePath: string, eventType: string) {
    this.pointCalls.push({ ref: websiteRef, path: pagePath, type: eventType });
    return { page_path: "/orders/:id", points: [POINT] };
  }

  async getLayoutSnapshot(websiteRef: string, pagePath: string) {
    this.snapshotCalls.push({ ref: websiteRef, path: pagePath });
    return { layout: LAYOUT };
  }

  async saveDashboardScreenshot(
    websiteRef: string,
    pagePath: string,
    imageBase64: string,
    docWidth: number,
    docHeight: number,
  ) {
    this.saveCalls.push({
      ref: websiteRef,
      path: pagePath,
      image: imageBase64,
      w: docWidth,
      h: docHeight,
    });
    if (this.saveThrows) throw this.saveThrows;
  }

  async bulkDeletePages(websiteRef: string, pagePaths: string[]) {
    this.deleteCalls.push({ ref: websiteRef, paths: pagePaths });
  }
}

class FakeScreenshots {
  captureCalls: { ref: string; req: CaptureScreenshotRequest }[] = [];
  batchCalls: { ref: string; reqs: CaptureScreenshotRequest[] }[] = [];

  /** When set, `capture` throws it. Used for the 403-vs-400 split. */
  captureThrows: Error | null = null;
  /** When set, `captureBatch` throws it — a whole-batch failure, not a per-item one. */
  batchThrows: Error | null = null;
  /** Per-item outcomes the batch reports back; index-matched to the request list. */
  batchResults: BatchCaptureScreenshotResult[] | null = null;

  async capture(
    websiteRef: string,
    request: CaptureScreenshotRequest,
  ): Promise<CaptureScreenshotResult> {
    this.captureCalls.push({ ref: websiteRef, req: request });
    if (this.captureThrows) throw this.captureThrows;
    return { success: true, s3Key: "sites/w/pages/p.jpg", stored: true };
  }

  async captureBatch(
    websiteRef: string,
    requests: CaptureScreenshotRequest[],
  ): Promise<BatchCaptureScreenshotResult[]> {
    this.batchCalls.push({ ref: websiteRef, reqs: requests });
    if (this.batchThrows) throw this.batchThrows;
    if (this.batchResults) return this.batchResults;
    return requests.map((r) => ({ pagePath: r.pagePath, success: true, stored: true }));
  }
}

let websites: FakeWebsites;
let heatmaps: FakeHeatmaps;
let screenshots: FakeScreenshots;
let app: ReturnType<typeof createHeatmapRoutes>;

beforeEach(() => {
  websites = new FakeWebsites();
  heatmaps = new FakeHeatmaps();
  screenshots = new FakeScreenshots();
  app = createHeatmapRoutes({
    heatmapQueries: heatmaps,
    heatmapMutations: heatmaps,
    screenshots,
    websites,
  });
});

/** A GET as `user`, or unauthenticated when `user` is null. */
function get(path: string, user: string | null = "u_viewer") {
  return app.request(path, {
    headers: user ? { "X-Test-User": user } : {},
  });
}

/** A JSON body request. `body` is sent verbatim when it is a string, so a test can send malformed JSON. */
function send(
  method: "POST" | "DELETE",
  path: string,
  body: unknown,
  user: string | null = "u_owner",
) {
  return app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "X-Test-User": user } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * Every endpoint on this surface, as a request builder.
 *
 * The access checks below run over this list rather than naming one route, because
 * `guarded` is opt-in at registration: a new endpoint that forgets it is a hole, and the
 * only thing that can notice is a test that enumerates the surface.
 */
const ENDPOINTS: {
  name: string;
  // `Hono.request` is typed as returning either, so the awaited form is what callers use.
  call: (user: string | null, ref?: string) => Response | Promise<Response>;
}[] = [
    {
      name: "GET /pages",
      call: (u, ref = WEBSITE) => get(`/${ref}/pages`, u),
    },
    {
      name: "GET /data",
      call: (u, ref = WEBSITE) => get(`/${ref}/data?page_path=%2Fpricing`, u),
    },
    {
      name: "GET /layout-snapshot",
      call: (u, ref = WEBSITE) => get(`/${ref}/layout-snapshot?page_path=%2Fpricing`, u),
    },
    {
      name: "POST /save-screenshot",
      call: (u, ref = WEBSITE) =>
        send("POST", `/${ref}/save-screenshot`, { page_path: "/p", image: "x" }, u),
    },
    {
      name: "DELETE /bulk-delete",
      call: (u, ref = WEBSITE) =>
        send("DELETE", `/${ref}/bulk-delete`, { pagePaths: ["/p"] }, u),
    },
    {
      name: "POST /playwright-screenshot",
      call: (u, ref = WEBSITE) =>
        send(
          "POST",
          `/${ref}/playwright-screenshot`,
          { page_url: "https://x.test/p", page_path: "/p" },
          u,
        ),
    },
    {
      name: "POST /playwright-batch-screenshots",
      call: (u, ref = WEBSITE) =>
        send(
          "POST",
          `/${ref}/playwright-batch-screenshots`,
          { screenshots: [{ page_url: "https://x.test/p", page_path: "/p" }] },
          u,
        ),
    },
  ];

describe("heatmap routes", () => {
  describe("access", () => {
    for (const ep of ENDPOINTS) {
      it(`rejects an unauthenticated ${ep.name}`, async () => {
        const res = await ep.call(null);
        expect(res.status).toBe(401);
      });

      it(`rejects a stranger on ${ep.name}`, async () => {
        const res = await ep.call("u_nobody");
        expect(res.status).toBe(403);
      });

      it(`answers 403, not 404, for an unknown website on ${ep.name}`, async () => {
        // A 404 here would confirm which website ids do not exist, and by omission
        // which do. Registration is open, so that is a free enumeration oracle.
        const res = await ep.call("u_owner", OTHER_WEBSITE);
        expect(res.status).toBe(403);
      });
    }

    it("does not reach the service when it refuses a stranger", async () => {
      await Promise.all(ENDPOINTS.map((ep) => ep.call("u_nobody")));

      expect(heatmaps.listPagesCalls).toEqual([]);
      expect(heatmaps.pointCalls).toEqual([]);
      expect(heatmaps.snapshotCalls).toEqual([]);
      expect(heatmaps.saveCalls).toEqual([]);
      expect(heatmaps.deleteCalls).toEqual([]);
      expect(screenshots.captureCalls).toEqual([]);
      expect(screenshots.batchCalls).toEqual([]);
    });

    it("never launches a capture for an unknown website", async () => {
      // The guard has to run before the handler, not inside it: the capture path is the
      // one that costs a browser and an outbound request.
      await send(
        "POST",
        `/${OTHER_WEBSITE}/playwright-screenshot`,
        { page_url: "https://x.test/p", page_path: "/p" },
        "u_owner",
      );

      expect(screenshots.captureCalls).toEqual([]);
    });

    it("checks the role against the website in the path, not a resolved one", async () => {
      await get(`/${OTHER_WEBSITE}/pages`, "u_owner");

      expect(websites.roleCalls).toEqual([{ websiteRef: OTHER_WEBSITE, userId: "u_owner" }]);
    });

    it("lets a viewer read heatmap pages", async () => {
      // Reads are open to every role that has any access at all; only the recordings
      // surface narrows delete further.
      const res = await get(`/${WEBSITE}/pages`, "u_viewer");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pages: [PAGE] });
    });

    it("lets a viewer delete heatmap pages", async () => {
      // Pinning what this surface actually does rather than what it should do. Heatmap
      // points are aggregates that regenerate from live traffic, so unlike a session
      // recording a viewer-triggered delete is not destruction of unrecoverable data.
      // If that judgement changes, this is the test that has to change with it.
      const res = await send("DELETE", `/${WEBSITE}/bulk-delete`, { pagePaths: ["/p"] }, "u_viewer");

      expect(res.status).toBe(204);
    });
  });

  describe("GET /pages", () => {
    it("passes the website reference straight through", async () => {
      await get(`/${WEBSITE}/pages`, "u_member");

      expect(heatmaps.listPagesCalls).toEqual([WEBSITE]);
    });

    it("returns the service's payload unwrapped", async () => {
      const res = await get(`/${WEBSITE}/pages`);

      expect(await res.json()).toEqual({ pages: [PAGE] });
    });
  });

  describe("GET /data", () => {
    it("defaults the event type to click", async () => {
      await get(`/${WEBSITE}/data?page_path=%2Fpricing`);

      expect(heatmaps.pointCalls).toEqual([
        { ref: WEBSITE, path: "/pricing", type: "click" },
      ]);
    });

    it("passes scroll through", async () => {
      await get(`/${WEBSITE}/data?page_path=%2Fpricing&event_type=scroll`);

      expect(heatmaps.pointCalls[0]?.type).toBe("scroll");
    });

    it("rejects an event type outside the two it stores", async () => {
      // The column holds exactly `click` and `scroll` at two different scales; anything
      // else would query a bucket that cannot exist and read as "no data".
      const res = await get(`/${WEBSITE}/data?page_path=%2Fp&event_type=hover`);

      expect(res.status).toBe(400);
      expect(heatmaps.pointCalls).toEqual([]);
    });

    it("requires a page path", async () => {
      const res = await get(`/${WEBSITE}/data`);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation_error" });
    });

    it("rejects a blank page path rather than querying for it", async () => {
      const res = await get(`/${WEBSITE}/data?page_path=%20%20`);

      expect(res.status).toBe(400);
      expect(heatmaps.pointCalls).toEqual([]);
    });

    it("rejects a page path past the column bound", async () => {
      const res = await get(`/${WEBSITE}/data?page_path=%2F${"a".repeat(2049)}`);

      expect(res.status).toBe(400);
    });

    it("accepts a page path exactly at the bound", async () => {
      const path = `/${"a".repeat(2047)}`;
      const res = await get(`/${WEBSITE}/data?page_path=${encodeURIComponent(path)}`);

      expect(res.status).toBe(200);
      expect(heatmaps.pointCalls[0]?.path).toBe(path);
    });

    it("returns the normalized path the service matched on, not the one requested", async () => {
      // `/orders/8213` is answered from the `/orders/:id` bucket, and the client has to
      // be able to tell — otherwise it renders points for a path it never asked about.
      const res = await get(`/${WEBSITE}/data?page_path=%2Forders%2F8213`);

      expect(await res.json()).toEqual({ page_path: "/orders/:id", points: [POINT] });
    });
  });

  describe("GET /layout-snapshot", () => {
    it("requires a page path", async () => {
      const res = await get(`/${WEBSITE}/layout-snapshot`);

      expect(res.status).toBe(400);
      expect(heatmaps.snapshotCalls).toEqual([]);
    });

    it("passes the path through and returns the layout", async () => {
      const res = await get(`/${WEBSITE}/layout-snapshot?page_path=%2Fpricing`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ layout: LAYOUT });
      expect(heatmaps.snapshotCalls).toEqual([{ ref: WEBSITE, path: "/pricing" }]);
    });

    it("ignores an event_type it has no use for", async () => {
      // The snapshot schema has no `event_type`, and zod strips unknown keys rather
      // than rejecting — so a client reusing the `/data` query string still works.
      const res = await get(
        `/${WEBSITE}/layout-snapshot?page_path=%2Fpricing&event_type=scroll`,
      );

      expect(res.status).toBe(200);
    });
  });

  describe("POST /save-screenshot", () => {
    it("stores the dashboard's own render", async () => {
      const res = await send("POST", `/${WEBSITE}/save-screenshot`, {
        page_path: "/pricing",
        image: "data:image/jpeg;base64,AAAA",
        doc_width: 1440,
        doc_height: 3000,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(heatmaps.saveCalls).toEqual([
        {
          ref: WEBSITE,
          path: "/pricing",
          image: "data:image/jpeg;base64,AAAA",
          w: 1440,
          h: 3000,
        },
      ]);
    });

    it("requires both a path and an image", async () => {
      const noImage = await send("POST", `/${WEBSITE}/save-screenshot`, { page_path: "/p" });
      const noPath = await send("POST", `/${WEBSITE}/save-screenshot`, { image: "x" });

      expect(noImage.status).toBe(400);
      expect(noPath.status).toBe(400);
      expect(heatmaps.saveCalls).toEqual([]);
    });

    it("treats a non-string image as absent rather than coercing it", async () => {
      // `stringOrEmpty` is why: a number here would otherwise reach the JPEG check as
      // the string "12345" and fail much further in, with a worse message.
      const res = await send("POST", `/${WEBSITE}/save-screenshot`, {
        page_path: "/p",
        image: 12345,
      });

      expect(res.status).toBe(400);
      expect(heatmaps.saveCalls).toEqual([]);
    });

    it("defaults absent document dimensions to zero", async () => {
      await send("POST", `/${WEBSITE}/save-screenshot`, { page_path: "/p", image: "x" });

      expect(heatmaps.saveCalls[0]).toMatchObject({ w: 0, h: 0 });
    });

    it("passes a non-numeric dimension on as NaN rather than a default", async () => {
      // This route uses `Number(...)` directly, unlike the capture routes' `numberOr`.
      // Pinning it because the two behave differently on the same input, and the service
      // below is what has to cope.
      await send("POST", `/${WEBSITE}/save-screenshot`, {
        page_path: "/p",
        image: "x",
        doc_width: "wide",
      });

      expect(heatmaps.saveCalls[0]!.w).toBeNaN();
    });

    it("reports the service's rejection message, because it is actionable", async () => {
      heatmaps.saveThrows = new Error("not a valid JPEG");

      const res = await send("POST", `/${WEBSITE}/save-screenshot`, {
        page_path: "/p",
        image: "x",
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("not a valid JPEG");
    });

    it("rejects a malformed body before reading any field", async () => {
      const res = await send("POST", `/${WEBSITE}/save-screenshot`, "{not json");

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid json" });
      expect(heatmaps.saveCalls).toEqual([]);
    });
  });

  describe("DELETE /bulk-delete", () => {
    it("answers 204 with no body", async () => {
      const res = await send("DELETE", `/${WEBSITE}/bulk-delete`, {
        pagePaths: ["/a", "/b"],
      });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(heatmaps.deleteCalls).toEqual([{ ref: WEBSITE, paths: ["/a", "/b"] }]);
    });

    it("rejects an empty path list rather than deleting nothing", async () => {
      const res = await send("DELETE", `/${WEBSITE}/bulk-delete`, { pagePaths: [] });

      expect(res.status).toBe(400);
      expect(heatmaps.deleteCalls).toEqual([]);
    });

    it("rejects a missing path list", async () => {
      const res = await send("DELETE", `/${WEBSITE}/bulk-delete`, {});

      expect(res.status).toBe(400);
      expect(heatmaps.deleteCalls).toEqual([]);
    });

    it("rejects a batch past the 500-path cap", async () => {
      const res = await send("DELETE", `/${WEBSITE}/bulk-delete`, {
        pagePaths: Array.from({ length: 501 }, (_, i) => `/p${i}`),
      });

      expect(res.status).toBe(400);
      expect(heatmaps.deleteCalls).toEqual([]);
    });

    it("accepts a batch exactly at the cap", async () => {
      const res = await send("DELETE", `/${WEBSITE}/bulk-delete`, {
        pagePaths: Array.from({ length: 500 }, (_, i) => `/p${i}`),
      });

      expect(res.status).toBe(204);
      expect(heatmaps.deleteCalls[0]!.paths).toHaveLength(500);
    });

    it("rejects a non-string path instead of deleting a coerced one", async () => {
      const res = await send("DELETE", `/${WEBSITE}/bulk-delete`, { pagePaths: ["/a", 7] });

      expect(res.status).toBe(400);
      expect(heatmaps.deleteCalls).toEqual([]);
    });

    it("rejects a blank path", async () => {
      const res = await send("DELETE", `/${WEBSITE}/bulk-delete`, { pagePaths: ["  "] });

      expect(res.status).toBe(400);
    });

    it("rejects a malformed body", async () => {
      const res = await send("DELETE", `/${WEBSITE}/bulk-delete`, "{oops");

      expect(res.status).toBe(400);
      expect(heatmaps.deleteCalls).toEqual([]);
    });
  });

  describe("POST /playwright-screenshot", () => {
    it("captures and reports the result", async () => {
      const res = await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/pricing",
        page_path: "/pricing",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        data: { success: true, s3Key: "sites/w/pages/p.jpg", stored: true },
      });
    });

    it("requires both a url and a path", async () => {
      const noUrl = await send("POST", `/${WEBSITE}/playwright-screenshot`, { page_path: "/p" });
      const noPath = await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/p",
      });

      expect(noUrl.status).toBe(400);
      expect(noPath.status).toBe(400);
      expect(screenshots.captureCalls).toEqual([]);
    });

    it("answers 403 for a refused target, not 400", async () => {
      // The whole point of the split: 403 says the URL is off-limits — the SSRF guard
      // fired — while 400 says it would not load. Only one of those is worth retrying
      // with a different page, and only one indicates the caller probed somewhere it
      // should not have.
      screenshots.captureThrows = new ScreenshotTargetNotAllowedError("blocked host");

      const res = await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "http://169.254.169.254/latest/meta-data/",
        page_path: "/p",
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "page_url not allowed" });
    });

    it("does not leak the refusal's detail in the body", async () => {
      // The refusal message names what the guard resolved the host to. Echoing it back
      // turns a blocked request into a working DNS-and-reachability probe.
      screenshots.captureThrows = new ScreenshotTargetNotAllowedError(
        "resolved to private range 10.0.0.5",
      );

      const res = await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "http://internal.svc/",
        page_path: "/p",
      });

      expect((await res.json()).error).toBe("page_url not allowed");
    });

    it("answers 400 with the message for a page that would not load", async () => {
      screenshots.captureThrows = new Error("page would not load");

      const res = await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/gone",
        page_path: "/gone",
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("page would not load");
    });

    it("stringifies a non-Error rejection rather than answering with nothing", async () => {
      screenshots.captureThrows = "just a string" as unknown as Error;

      const res = await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/p",
        page_path: "/p",
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("just a string");
    });

    it("applies the viewport and quality defaults", async () => {
      await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/p",
        page_path: "/p",
      });

      expect(screenshots.captureCalls[0]!.req).toMatchObject({
        viewportWidth: 1920,
        viewportHeight: 1080,
        jpegQuality: 85,
      });
    });

    it("honours supplied viewport and quality", async () => {
      await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/p",
        page_path: "/p",
        viewport_width: 390,
        viewport_height: 844,
        jpeg_quality: 60,
      });

      expect(screenshots.captureCalls[0]!.req).toMatchObject({
        viewportWidth: 390,
        viewportHeight: 844,
        jpegQuality: 60,
      });
    });

    it("falls back to the default for an unparseable viewport", async () => {
      // Coercion, not rejection: a missing or broken viewport means "use the default".
      await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/p",
        page_path: "/p",
        viewport_width: "wide",
        jpeg_quality: null,
      });

      expect(screenshots.captureCalls[0]!.req).toMatchObject({
        viewportWidth: 1920,
        jpegQuality: 85,
      });
    });

    it("falls back to the default for an infinite viewport", async () => {
      // `Number("1e400")` is `Infinity`, which is finite-checked rather than passed to
      // Playwright as a viewport it cannot allocate.
      await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/p",
        page_path: "/p",
        viewport_height: "1e400",
      });

      expect(screenshots.captureCalls[0]!.req.viewportHeight).toBe(1080);
    });

    it("passes a selector through only when it is a string", async () => {
      await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/p",
        page_path: "/p",
        wait_for_selector: "#main",
      });
      await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/p",
        page_path: "/p",
        wait_for_selector: 42,
      });

      expect(screenshots.captureCalls[0]!.req.waitForSelector).toBe("#main");
      expect(screenshots.captureCalls[1]!.req.waitForSelector).toBeUndefined();
    });

    it("treats force and check_only as strictly boolean true", async () => {
      // `=== true`, not truthiness: `"false"` from a form-encoded client must not
      // become a forced capture, and `check_only: "no"` must not skip the browser.
      await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/p",
        page_path: "/p",
        force: "true",
        check_only: 1,
      });

      expect(screenshots.captureCalls[0]!.req).toMatchObject({
        force: false,
        checkOnly: false,
      });
    });

    it("forwards force and check_only when they really are true", async () => {
      await send("POST", `/${WEBSITE}/playwright-screenshot`, {
        page_url: "https://x.test/p",
        page_path: "/p",
        force: true,
        check_only: true,
      });

      expect(screenshots.captureCalls[0]!.req).toMatchObject({
        force: true,
        checkOnly: true,
      });
    });

    it("rejects a malformed body before capturing", async () => {
      const res = await send("POST", `/${WEBSITE}/playwright-screenshot`, "not json at all");

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid json" });
      expect(screenshots.captureCalls).toEqual([]);
    });
  });

  describe("POST /playwright-batch-screenshots", () => {
    it("captures every entry and summarises the outcome", async () => {
      screenshots.batchResults = [
        { pagePath: "/a", success: true, stored: true },
        { pagePath: "/b", success: false, error: "timeout" },
        { pagePath: "/c", success: true, stored: false },
      ];

      const res = await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: [
          { page_url: "https://x.test/a", page_path: "/a" },
          { page_url: "https://x.test/b", page_path: "/b" },
          { page_url: "https://x.test/c", page_path: "/c" },
        ],
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        summary: { total: 3, succeeded: 2, failed: 1 },
      });
    });

    it("reports a per-item failure as 200, not as a failed request", async () => {
      // One dead page must not lose the other 49 results — that is why the service
      // reports errors per request instead of throwing.
      screenshots.batchResults = [{ pagePath: "/a", success: false, error: "timeout" }];

      const res = await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: [{ page_url: "https://x.test/a", page_path: "/a" }],
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ summary: { total: 1, succeeded: 0, failed: 1 } });
    });

    it("requires a non-empty array", async () => {
      const empty = await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: [],
      });
      const missing = await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {});

      expect(empty.status).toBe(400);
      expect(missing.status).toBe(400);
      expect(screenshots.batchCalls).toEqual([]);
    });

    it("treats a non-array screenshots field as absent", async () => {
      const res = await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: { page_url: "https://x.test/a", page_path: "/a" },
      });

      expect(res.status).toBe(400);
      expect(screenshots.batchCalls).toEqual([]);
    });

    it("refuses a batch past the 50-page ceiling", async () => {
      // Each entry launches a browser, sequentially. The ceiling is what stops one
      // request from occupying the capture path for an unbounded stretch.
      const res = await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: Array.from({ length: 51 }, (_, i) => ({
          page_url: `https://x.test/p${i}`,
          page_path: `/p${i}`,
        })),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("maximum 50");
      expect(screenshots.batchCalls).toEqual([]);
    });

    it("accepts a batch exactly at the ceiling", async () => {
      const res = await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: Array.from({ length: 50 }, (_, i) => ({
          page_url: `https://x.test/p${i}`,
          page_path: `/p${i}`,
        })),
      });

      expect(res.status).toBe(200);
      expect(screenshots.batchCalls[0]!.reqs).toHaveLength(50);
    });

    it("applies the per-item defaults", async () => {
      await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: [{ page_url: "https://x.test/a", page_path: "/a" }],
      });

      expect(screenshots.batchCalls[0]!.reqs[0]).toMatchObject({
        viewportWidth: 1920,
        viewportHeight: 1080,
        jpegQuality: 85,
      });
    });

    it("keeps each item's own options rather than the first item's", async () => {
      await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: [
          { page_url: "https://x.test/a", page_path: "/a", viewport_width: 390 },
          { page_url: "https://x.test/b", page_path: "/b" },
        ],
      });

      expect(screenshots.batchCalls[0]!.reqs[0]!.viewportWidth).toBe(390);
      expect(screenshots.batchCalls[0]!.reqs[1]!.viewportWidth).toBe(1920);
    });

    it("passes a malformed entry through as blanks rather than rejecting the batch", async () => {
      // The batch route validates the envelope, not each entry: an item with no url
      // arrives as an empty string and fails as its own result. Rejecting the whole
      // batch would lose the 49 valid entries alongside it.
      await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: [{ page_path: "/a" }],
      });

      expect(screenshots.batchCalls[0]!.reqs[0]).toMatchObject({
        pageUrl: "",
        pagePath: "/a",
      });
    });

    it("does not forward force or check_only from a batch entry", async () => {
      // The batch projection omits both, so a caller cannot use the batch endpoint to
      // force 50 re-captures past the content-hash short circuit.
      await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: [
          { page_url: "https://x.test/a", page_path: "/a", force: true, check_only: true },
        ],
      });

      expect(screenshots.batchCalls[0]!.reqs[0]!.force).toBeUndefined();
      expect(screenshots.batchCalls[0]!.reqs[0]!.checkOnly).toBeUndefined();
    });

    it("answers 400 when the whole batch throws", async () => {
      screenshots.batchThrows = new Error("browser pool exhausted");

      const res = await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: [{ page_url: "https://x.test/a", page_path: "/a" }],
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("browser pool exhausted");
    });

    it("rejects a malformed body before capturing", async () => {
      const res = await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, "[[[");

      expect(res.status).toBe(400);
      expect(screenshots.batchCalls).toEqual([]);
    });
  });

  describe("routing", () => {
    it("does not treat the capture paths as a website id", async () => {
      // `/:website_id/pages` is a two-segment pattern and so is `/:website_id/data`;
      // a single-segment request must not fall into either.
      const res = await get(`/${WEBSITE}`, "u_owner");

      expect(res.status).toBe(404);
    });

    it("keeps the batch endpoint distinct from the single one", async () => {
      await send("POST", `/${WEBSITE}/playwright-batch-screenshots`, {
        screenshots: [{ page_url: "https://x.test/a", page_path: "/a" }],
      });

      expect(screenshots.captureCalls).toEqual([]);
      expect(screenshots.batchCalls).toHaveLength(1);
    });
  });
});
