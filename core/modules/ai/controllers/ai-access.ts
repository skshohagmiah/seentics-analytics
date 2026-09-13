import type { Context } from "hono";
import { requireUser, type AuthVars } from "../../../platform/middleware/auth";
import type { AiControllerDeps } from "./ai-controller.types";

export async function requireAiAccess(
  c: Context<{ Variables: AuthVars }>,
  deps: AiControllerDeps,
  websiteRef: string,
): Promise<{ userId: string } | { denied: Response }> {
  const userId = requireUser(c);
  if (!userId) return { denied: c.json({ error: "unauthorized" }, 401) };
  if (!(await deps.websites.getRole(websiteRef, userId))) {
    return { denied: c.json({ error: "website not found or access denied" }, 403) };
  }
  return { userId };
}
