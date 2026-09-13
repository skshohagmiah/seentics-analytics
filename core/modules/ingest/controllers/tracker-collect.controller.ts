import type { Context } from "hono";
import { env } from "../../../config";
import type { TrackerCollectBody } from "../../../platform/lib/api-types";
import { clientIpForIngest } from "../../../platform/lib/client-ip";
import { originFromRequest, validateOriginDomain } from "../../../platform/lib/origin";
import { validationErrorResponse } from "../../../platform/validation";
import { trackerCollectSchema } from "../validators/tracker.schema";
import {
  readTrackerCollectBody,
  trackerCollectRequestItemCount,
} from "./tracker-collect-request";
import type { TrackerControllerDeps } from "./tracker-controller.types";

export function collectTracker(deps: TrackerControllerDeps) {
  return async (c: Context) => {
    const cfg = env();
    let body: TrackerCollectBody;
    try {
      const parsed = trackerCollectSchema.safeParse(await readTrackerCollectBody(c.req.raw));
      if (!parsed.success) return validationErrorResponse(c, parsed.error);
      body = parsed.data as unknown as TrackerCollectBody;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const websiteId = typeof body.website_id === "string" ? body.website_id.trim() : "";
    if (!websiteId) return c.json({ error: "website_id is required" }, 400);
    if (trackerCollectRequestItemCount(body) === 0) {
      return c.json({ status: "ok", message: "nothing to process" });
    }

    const website = await deps.trackerWebsites.resolve(websiteId);
    if (!website || !website.is_active) {
      return c.json({ error: "website not found or inactive" }, 404);
    }
    const origin = originFromRequest(c.req.raw.headers);
    if (!validateOriginDomain(origin, website.url, cfg.environment)) {
      return c.json({ error: "domain mismatch" }, 403);
    }

    const result = deps.collect.process({
      body,
      website,
      websiteParam: websiteId,
      origin,
      headers: c.req.raw.headers,
      clientIp: clientIpForIngest(c, cfg.trustProxy, cfg.isProduction),
      diagnosticLog: cfg.diagnosticLog,
    });
    if (result.kind === "empty") return c.json({ status: "ok", message: "nothing to process" });
    if (result.kind === "privacy-disabled") {
      return c.json({ status: "ok", message: "tracking disabled by privacy policy" });
    }
    return c.json({ status: "ok", message: "processed", queued: result.queued });
  };
}
