import type { Context } from "hono";
import { env } from "../../../config";
import { originFromRequest, validateOriginDomain } from "../../../platform/lib/origin";
import type { TrackerControllerDeps } from "./tracker-controller.types";

type WebsiteParamContext = Context<any, "/init/:website_id">;
type ConfigParamContext = Context<any, "/config/:website_id">;

export function initTracker(deps: TrackerControllerDeps) {
  return async (c: WebsiteParamContext) => {
    const websiteId = c.req.param("website_id");
    const origin = originFromRequest(c.req.raw.headers);
    const website = await deps.trackerWebsites.resolve(websiteId);
    if (!website || !website.is_active) {
      return c.json({ error: "website not found or inactive" }, 404);
    }
    if (!validateOriginDomain(origin, website.url, env().environment)) {
      return c.json({ error: "domain mismatch" }, 403);
    }

    let goals: Awaited<ReturnType<typeof deps.trackerWebsites.listGoals>> = [];
    try {
      goals = await deps.trackerWebsites.listGoals(website.id);
    } catch {
      goals = [];
    }

    const config = await deps.trackerWebsites.buildConfig(website, goals);
    let funnels: unknown[] = [];
    let automations: unknown[] = [];
    try {
      funnels = await deps.funnels.activeForTracker(website.id);
    } catch {
      funnels = [];
    }
    try {
      const rows = await deps.automations.activeFor(website.id);
      automations = rows.map((automation) => ({
        id: automation.id,
        name: automation.name,
        ...automation.definition,
      }));
    } catch {
      automations = [];
    }

    c.header("Cache-Control", "private, max-age=60, stale-while-revalidate=120");
    return c.json({ config, funnels, automations });
  };
}

export function getTrackerConfig(deps: TrackerControllerDeps) {
  return async (c: ConfigParamContext) => {
    const websiteId = c.req.param("website_id");
    const origin = originFromRequest(c.req.raw.headers);
    const website = await deps.trackerWebsites.resolve(websiteId);
    if (!website || !website.is_active) {
      return c.json({ error: "website not found or inactive" }, 404);
    }
    if (!validateOriginDomain(origin, website.url, env().environment)) {
      return c.json({ error: "domain mismatch" }, 403);
    }

    let goals: Awaited<ReturnType<typeof deps.trackerWebsites.listGoals>> = [];
    try {
      goals = await deps.trackerWebsites.listGoals(website.id);
    } catch {
      goals = [];
    }
    const config = await deps.trackerWebsites.buildConfig(website, goals);
    c.header("Cache-Control", "private, max-age=60, stale-while-revalidate=120");
    return c.json(config);
  };
}
