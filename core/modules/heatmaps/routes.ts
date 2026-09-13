import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { authMiddleware, requireUser, type AuthVars } from "../../platform/middleware/auth";
import { parseJson, parseQuery } from "../../platform/validation";
import type { WebsiteQuery } from "../websites/interfaces";
import type {
  HeatmapMutations,
  HeatmapQuery,
  HeatmapScreenshotCapture,
} from "./interfaces";
// Imported from the schema module rather than a barrel: these schemas carry
// defaults, and their inferred output widens when re-exported, which silently
// costs the handlers their parameter types.
import {
  heatmapBulkDeleteSchema,
  heatmapDataQuerySchema,
  heatmapSnapshotQuerySchema,
} from "./validators/heatmap.schema";
import { registerCaptureRoutes } from "./capture-routes";
import { readJsonBody, stringOrEmpty } from "./lib/request-body";

/**
 * HTTP surface for heatmaps, mounted at `/api/v1/heatmaps`.
 *
 * A factory rather than a module-level singleton, so dependencies arrive at
 * composition time instead of being reached for through imports — which is what
 * lets these routes run against stubs in a test.
 */
export function createHeatmapRoutes(deps: {
  heatmaps: HeatmapQuery & HeatmapMutations;
  screenshots: HeatmapScreenshotCapture;
  websites: WebsiteQuery;
}) {
  const { heatmaps, screenshots, websites } = deps;
  const r = new Hono<{ Variables: AuthVars }>();

  r.use(authMiddleware);

  /**
   * Authenticate and confirm the caller may touch this website's heatmaps.
   *
   * Returns a `Response` to short-circuit with, or `null` to proceed — the shape
   * that keeps each handler to two lines instead of a nested try/catch.
   *
   * Answers 403 for an unknown website as well as a forbidden one, so the endpoint
   * cannot be used to enumerate which site ids exist. It also answers 403 rather
   * than 401 for a missing user, matching what this surface has always returned.
   */
  async function denyUnlessPermitted(
    c: Context<{ Variables: AuthVars }>,
    websiteRef: string,
  ): Promise<Response | null> {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: "forbidden" }, 403);

    const role = await websites.getRole(websiteRef, userId);
    if (!role) return c.json({ error: "forbidden" }, 403 as ContentfulStatusCode);

    return null;
  }

  /**
   * Hoist the access check out of every handler.
   *
   * Each route below repeated the same three lines to extract the website reference
   * and run the guard. Doing it here means an individual route cannot omit it. The
   * handler keeps full control of its own response, so status codes and bodies are
   * unchanged.
   */
  function guarded(
    handle: (c: Context<{ Variables: AuthVars }>, websiteRef: string) => Promise<Response>,
  ) {
    return async (c: Context<{ Variables: AuthVars }>) => {
      // Typed optional because this handler is generic over the path; Hono only
      // routes here when `:website_id` matched.
      const websiteRef = c.req.param("website_id");
      if (!websiteRef) return c.json({ error: "not found" }, 404);

      const denied = await denyUnlessPermitted(c, websiteRef);
      if (denied) return denied;

      return handle(c, websiteRef);
    };
  }

  // GET /:website_id/pages — every page with heatmap data, busiest first.
  r.get("/:website_id/pages", guarded(async (c, websiteRef) => {

    const out = await heatmaps.listPages(websiteRef);
    return c.json(out);
  }));

  // GET /:website_id/data — click or scroll points for one page.
  r.get("/:website_id/data", guarded(async (c, websiteRef) => {

    const q = parseQuery(c, heatmapDataQuerySchema);
    if (!q.ok) return q.res;

    const out = await heatmaps.getPoints(websiteRef, q.data.page_path, q.data.event_type || "click");
    return c.json(out);
  }));

  // GET /:website_id/layout-snapshot — the background the overlay draws on.
  r.get("/:website_id/layout-snapshot", guarded(async (c, websiteRef) => {

    const q = parseQuery(c, heatmapSnapshotQuerySchema);
    if (!q.ok) return q.res;

    const out = await heatmaps.getLayoutSnapshot(websiteRef, q.data.page_path, q.data.device);
    return c.json(out);
  }));

  /**
   * POST /:website_id/save-screenshot
   *
   * The dashboard's own html2canvas render. Every rejection is a 400 carrying the
   * service's message, because each one tells the user something actionable
   * ("not a valid JPEG", "size out of range").
   */
  r.post("/:website_id/save-screenshot", guarded(async (c, websiteRef) => {

    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.res;

    const pagePath = stringOrEmpty(parsed.body.page_path);
    const image = stringOrEmpty(parsed.body.image);
    const docWidth = Number(parsed.body.doc_width ?? 0);
    const docHeight = Number(parsed.body.doc_height ?? 0);

    if (!pagePath || !image) {
      return c.json({ error: "page_path and image required" }, 400);
    }

    try {
      await heatmaps.saveDashboardScreenshot(websiteRef, pagePath, image, docWidth, docHeight);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  }));

  // DELETE /:website_id/bulk-delete — 204, no body.
  r.delete("/:website_id/bulk-delete", guarded(async (c, websiteRef) => {

    const parsed = await parseJson(c, heatmapBulkDeleteSchema);
    if (!parsed.ok) return parsed.res;

    await heatmaps.bulkDeletePages(websiteRef, parsed.data.pagePaths);
    return c.body(null, 204);
  }));

  /**
   * POST /:website_id/playwright-screenshot
   * Capture a webpage screenshot using Playwright and store in S3/MinIO.
   *
   * Request body:
   * {
   *   "page_url": "https://example.com/page",
   *   "page_path": "/page",
   *   "viewport_width": 1920,
   *   "viewport_height": 1080,
   *   "wait_for_selector": "#main-content",
   *   "jpeg_quality": 85
   * }
   */
  registerCaptureRoutes(r, screenshots, guarded);

  return r;
}
