import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { validationErrorResponse } from "../../../platform/validation";
import { toFrontendUser } from "../lib/user-presenter";
import type { AuthControllerDeps } from "./auth-controller.types";
import { passthroughObjectSchema } from "../validators/auth.schema";

type AuthContext = Context<{ Variables: AuthVars }>;

export function setupStatus(deps: AuthControllerDeps) {
  return async (c: AuthContext) =>
    c.json({ data: { setupComplete: (await deps.accounts.countUsers()) > 0 } });
}

export function currentUser(deps: AuthControllerDeps) {
  return async (c: AuthContext) => {
    const row = await deps.accounts.getById(c.get("userId"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ data: { user: toFrontendUser(row) } });
  };
}

export function verifySecrets() {
  return async (c: AuthContext) => {
    const body = await c.req.json().catch(() => null);
    const parsed = passthroughObjectSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(c, parsed.error);
    return c.json({ data: { verified: false } });
  };
}
