import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireUser, type AuthVars } from "../../../platform/middleware/auth";
import type { AnalyticsQueryParams } from "../interfaces";
import type { AnalyticsControllerDeps } from "./analytics-controller.types";

export type AnalyticsContext = Context<{ Variables: AuthVars }>;

export function analyticsQuery(c: AnalyticsContext): AnalyticsQueryParams {
  return {
    days: c.req.query("days"),
    timezone: c.req.query("timezone"),
    limit: c.req.query("limit"),
  };
}

export async function requireAnalyticsAccess(
  c: AnalyticsContext,
  deps: AnalyticsControllerDeps,
  websiteRef: string,
): Promise<Response | null> {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  if (!(await deps.websites.getRole(websiteRef, userId))) {
    return c.json({ error: "forbidden" }, 403 as ContentfulStatusCode);
  }
  return null;
}

export function analyticsRead(
  deps: AnalyticsControllerDeps,
  read: (websiteRef: string, query: AnalyticsQueryParams) => Promise<unknown>,
) {
  return async (c: AnalyticsContext) => {
    const websiteRef = c.req.param("website_id");
    if (!websiteRef) return c.json({ error: "not found" }, 404);
    const denied = await requireAnalyticsAccess(c, deps, websiteRef);
    if (denied) return denied;
    return c.json(await read(websiteRef, analyticsQuery(c)) as object);
  };
}
