import type { Context } from "hono";
import { env } from "../../../config";
import { log } from "../../../platform/lib/logger";
import { originFromRequest, validateOriginDomain } from "../../../platform/lib/origin";
import type { TrackerControllerDeps } from "./tracker-controller.types";

export function evaluateTrackerAutomation(deps: TrackerControllerDeps) {
  return async (c: Context) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const websiteId = typeof body.website_id === "string" ? body.website_id.trim() : "";
    if (!websiteId) return c.json({ error: "website_id required" }, 400);
    const anonymousId = typeof body.anonymous_id === "string" ? body.anonymous_id.trim() : "";
    const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
    if (!anonymousId || !sessionId) {
      return c.json({ error: "anonymous_id and session_id required" }, 400);
    }
    const triggerRaw = body.trigger;
    if (!triggerRaw || typeof triggerRaw !== "object" || Array.isArray(triggerRaw)) {
      return c.json({ error: "trigger object required" }, 400);
    }
    const trigger = triggerRaw as { type: string; [key: string]: unknown };
    if (!trigger.type) return c.json({ error: "trigger.type required" }, 400);

    const website = await deps.trackerWebsites.resolve(websiteId);
    if (!website || !website.is_active) {
      return c.json({ error: "website not found or inactive" }, 404);
    }
    const origin = originFromRequest(c.req.raw.headers);
    if (!validateOriginDomain(origin, website.url, env().environment)) {
      return c.json({ error: "domain mismatch" }, 403);
    }

    try {
      const result = await deps.automationEvaluation.evaluate({
        websiteId: website.id,
        anonymousId,
        userId: typeof body.user_id === "string" ? body.user_id : null,
        sessionId,
        trigger,
        context: body.context && typeof body.context === "object" && !Array.isArray(body.context)
          ? body.context as Record<string, unknown>
          : {},
      });
      return c.json({ status: "ok", matched: result.matched, actions: result.actions });
    } catch (err) {
      log.error({ msg: "automations_evaluate_error", websiteId, err });
      return c.json({ error: "evaluation failed" }, 500);
    }
  };
}
