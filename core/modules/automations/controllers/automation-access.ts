import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireUser, type AuthVars } from "../../../platform/middleware/auth";
import type { AutomationControllerDeps } from "./automation-controller.types";

export async function requireAutomationAccess(
  c: Context<{ Variables: AuthVars }>,
  deps: AutomationControllerDeps,
  websiteRef: string,
): Promise<{ userId: string } | { denied: Response }> {
  const userId = requireUser(c);
  if (!userId) return { denied: c.json({ error: "unauthorized" }, 401) };
  if (!(await deps.websites.getRole(websiteRef, userId))) {
    return { denied: c.json({ error: "forbidden" }, 403 as ContentfulStatusCode) };
  }
  return { userId };
}

export function automationResponse(c: Context, value: unknown) {
  if (value instanceof Response) return value;
  if (value === null) return c.json({ error: "not found" }, 404);
  return c.json({ data: value });
}
