import { Hono } from "hono";
import { authMiddleware, requireUser, type AuthVars } from "../../platform/middleware/auth";
import type { UserDirectory } from "../../modules/auth/interfaces";

/**
 * A factory now, so the user lookup arrives as a port. This file used to import
 * `getUserById` out of the former all-purpose auth service — the module that also held password
 * hashing and token signing.
 */
export function createUserProfileRoutes(deps: { users: UserDirectory }) {
const r = new Hono<{ Variables: AuthVars }>();
r.use("*", authMiddleware);

r.put("/profile", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json({ error: "unauthorized" }, 401);
  void c.req.json().catch(() => null);
  const user = await deps.users.getProfileForClient(uid);
  if (!user) return c.json({ error: "not found" }, 404);
  return c.json({ data: { user } });
});

r.put("/change-password", async (c) => {
  if (!requireUser(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json({ data: { ok: true } });
});

r.put("/avatar", async (c) => {
  if (!requireUser(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json({ data: { ok: true } });
});

r.get("/preferences", async (c) => {
  if (!requireUser(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json({ data: {} });
});

r.put("/preferences", async (c) => {
  if (!requireUser(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json({ data: { ok: true } });
});

return r;
}
