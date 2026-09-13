import type { Context } from "hono";
import { env } from "../../../config";
import {
  originFromRequest,
  validateOriginDomain,
  validateScreenshotTargetUrl,
} from "../../../platform/lib/origin";
import type { TrackerControllerDeps } from "./tracker-controller.types";

export function requestTrackerScreenshot(deps: TrackerControllerDeps) {
  return async (c: Context) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const websiteId = typeof body.website_id === "string" ? body.website_id.trim() : "";
    if (!websiteId) return c.json({ error: "website_id required" }, 400);
    const pageUrl = typeof body.page_url === "string" ? body.page_url.trim() : "";
    const pagePath = typeof body.page_path === "string" ? body.page_path.trim() : "";
    if (!pageUrl || !pagePath) return c.json({ error: "page_url and page_path required" }, 400);
    try {
      new URL(pageUrl);
    } catch {
      return c.json({ error: "invalid page_url" }, 400);
    }

    const website = await deps.trackerWebsites.resolve(websiteId);
    if (!website || !website.is_active) {
      return c.json({ error: "website not found or inactive" }, 404);
    }
    const origin = originFromRequest(c.req.raw.headers);
    if (!validateOriginDomain(origin, website.url, env().environment)) {
      return c.json({ error: "domain mismatch" }, 403);
    }
    if (!validateScreenshotTargetUrl(pageUrl, website.url)) {
      return c.json({ error: "page_url not allowed" }, 400);
    }

    void deps.screenshots.capture(websiteId, { pageUrl, pagePath, force: false }).catch(() => {});
    return c.json({ status: "queued" }, 202);
  };
}
