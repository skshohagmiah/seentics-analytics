import type { Context } from "hono";
import { requireUser, type AuthVars } from "../../../platform/middleware/auth";

export function importAnalytics() {
  return async (c: Context<{ Variables: AuthVars }>) => {
    if (!requireUser(c)) return c.json({ error: "unauthorized" }, 401);
    await c.req.json().catch(() => null);
    return c.json({ ok: true });
  };
}
