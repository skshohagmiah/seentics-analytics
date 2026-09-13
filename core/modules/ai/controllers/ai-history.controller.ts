import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { requireAiAccess } from "./ai-access";
import type { AiControllerDeps } from "./ai-controller.types";

const MAX_HISTORY = 20;

export function getAiHistory(deps: AiControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/history/:website_id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireAiAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const requested = Number.parseInt(c.req.query("limit") ?? "8", 10) || 8;
    const history = await deps.history.history(
      access.userId,
      websiteRef,
      Math.min(requested, MAX_HISTORY),
    );
    return c.json({ data: history });
  };
}
