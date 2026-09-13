import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import {
  ScreenshotTargetNotAllowedError,
  type CaptureScreenshotRequest,
} from "../interfaces";
import { numberOr, readJsonBody, stringOrEmpty } from "../lib/request-body";
import { requireHeatmapAccess } from "./heatmap-access";
import type { HeatmapControllerDeps } from "./heatmap-controller.types";

const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;
const JPEG_QUALITY = 85;
const MAX_BATCH = 50;

export function captureHeatmapScreenshot(deps: HeatmapControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id/playwright-screenshot">) => {
    const websiteRef = c.req.param("website_id");
    const denied = await requireHeatmapAccess(c, deps, websiteRef);
    if (denied) return denied;
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.res;
    const body = parsed.body;
    const pageUrl = stringOrEmpty(body.page_url);
    const pagePath = stringOrEmpty(body.page_path);
    if (!pageUrl || !pagePath) {
      return c.json({ error: "page_url and page_path are required" }, 400);
    }
    try {
      const data = await deps.screenshots.capture(websiteRef, {
        pageUrl,
        pagePath,
        viewportWidth: numberOr(body.viewport_width ?? VIEWPORT_WIDTH, VIEWPORT_WIDTH),
        viewportHeight: numberOr(body.viewport_height ?? VIEWPORT_HEIGHT, VIEWPORT_HEIGHT),
        waitForSelector: typeof body.wait_for_selector === "string" ? body.wait_for_selector : undefined,
        jpegQuality: numberOr(body.jpeg_quality ?? JPEG_QUALITY, JPEG_QUALITY),
        force: body.force === true,
        checkOnly: body.check_only === true,
      });
      return c.json({ ok: true, data });
    } catch (error) {
      if (error instanceof ScreenshotTargetNotAllowedError) {
        return c.json({ error: "page_url not allowed" }, 403);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  };
}

export function captureHeatmapScreenshotBatch(deps: HeatmapControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id/playwright-batch-screenshots">) => {
    const websiteRef = c.req.param("website_id");
    const denied = await requireHeatmapAccess(c, deps, websiteRef);
    if (denied) return denied;
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.res;
    const list = Array.isArray(parsed.body.screenshots) ? parsed.body.screenshots : [];
    if (!list.length) {
      return c.json({ error: "screenshots array is required and must not be empty" }, 400);
    }
    if (list.length > MAX_BATCH) {
      return c.json({ error: `maximum ${MAX_BATCH} screenshots per batch` }, 400);
    }
    try {
      const requests: CaptureScreenshotRequest[] = list.map((value) => {
        const item = value as Record<string, unknown>;
        return {
          pageUrl: stringOrEmpty(item.page_url),
          pagePath: stringOrEmpty(item.page_path),
          viewportWidth: numberOr(item.viewport_width, VIEWPORT_WIDTH),
          viewportHeight: numberOr(item.viewport_height, VIEWPORT_HEIGHT),
          waitForSelector: typeof item.wait_for_selector === "string" ? item.wait_for_selector : undefined,
          jpegQuality: numberOr(item.jpeg_quality, JPEG_QUALITY),
        };
      });
      const results = await deps.screenshots.captureBatch(websiteRef, requests);
      return c.json({
        ok: true,
        summary: {
          total: results.length,
          succeeded: results.filter((result) => result.success).length,
          failed: results.filter((result) => !result.success).length,
        },
        results,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  };
}
