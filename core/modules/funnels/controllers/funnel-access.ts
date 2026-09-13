import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { log } from "../../../platform/lib/logger";
import { requireUser, type AuthVars } from "../../../platform/middleware/auth";
import type { FunnelControllerDeps } from "./funnel-controller.types";

const funnelLog = log.child({ category: "funnels" });

export async function requireFunnelAccess(
  c: Context<{ Variables: AuthVars }>,
  deps: FunnelControllerDeps,
  websiteRef: string,
): Promise<{ userId: string } | { denied: Response }> {
  const userId = requireUser(c);
  if (!userId) return { denied: c.json({ error: "unauthorized" }, 401) };
  if (!(await deps.websites.getRole(websiteRef, userId))) {
    return { denied: c.json({ error: "forbidden" }, 403 as ContentfulStatusCode) };
  }
  return { userId };
}

export function funnelFailure(c: Context, op: string, websiteRef: string, error: unknown) {
  funnelLog.error({
    msg: "funnel_request_failed",
    op,
    website_id: websiteRef,
    err: error instanceof Error ? error.message : String(error),
  });
  return c.json({ error: "Failed to process funnel request" }, 500);
}
