import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import type { WebsitePrivacySettings } from "../interfaces";
import { requireWebsiteAccess } from "./website-access";
import type { WebsiteControllerDeps } from "./website-controller.types";

const defaults: WebsitePrivacySettings = {
  ipAnonymization: "none",
  respectDnt: false,
  consentMode: "cookieless",
  dataRetentionDays: null,
};

export function getWebsitePrivacy(deps: WebsiteControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:websiteId/privacy">) => {
    const websiteId = c.req.param("websiteId");
    const access = await requireWebsiteAccess(c, deps, websiteId, "owner");
    if ("denied" in access) return access.denied;
    return c.json({ success: true, data: await deps.privacy.get(websiteId) });
  };
}

export function updateWebsitePrivacy(deps: WebsiteControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:websiteId/privacy">) => {
    const websiteId = c.req.param("websiteId");
    const access = await requireWebsiteAccess(c, deps, websiteId, "owner");
    if ("denied" in access) return access.denied;
    const body = await c.req.json<Partial<WebsitePrivacySettings>>().catch(() => null);
    const ip = body?.ipAnonymization;
    const consent = body?.consentMode;
    const retention = body?.dataRetentionDays;
    if (!body || (ip != null && !["none", "partial", "full"].includes(ip)) ||
      (consent != null && !["cookieless", "strict"].includes(consent)) ||
      (retention != null && (!Number.isInteger(retention) || retention < 1 || retention > 3650)) ||
      (body.respectDnt != null && typeof body.respectDnt !== "boolean")) {
      return c.json({ error: "invalid privacy settings" }, 400);
    }
    const data = await deps.privacy.save(
      websiteId,
      access.userId,
      { ...defaults, ...body },
    );
    return c.json({ success: true, data });
  };
}
