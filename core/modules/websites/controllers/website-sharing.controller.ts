import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { requireWebsiteAccess, websiteDenied } from "./website-access";
import type { WebsiteControllerDeps } from "./website-controller.types";

export function updateWebsiteSharing(deps: WebsiteControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:id/share">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "admin");
    if ("denied" in access) return access.denied;
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({ enabled: true }));
    try {
      const shareId = await deps.sharing.setPublicSharing(websiteId, !!body.enabled);
      return c.json({ data: { public_share_id: shareId } });
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}
