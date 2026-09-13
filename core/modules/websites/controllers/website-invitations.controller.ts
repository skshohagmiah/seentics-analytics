import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseJson } from "../../../platform/validation";
import { invitationCreateSchema } from "../validators/website.schema";
import { requireWebsiteAccess, websiteDenied } from "./website-access";
import type { WebsiteControllerDeps } from "./website-controller.types";

type InvitationContext<Path extends string> = Context<{ Variables: AuthVars }, Path>;

export function listWebsiteInvitations(deps: WebsiteControllerDeps) {
  return async (c: InvitationContext<"/:id/invitations">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "admin");
    if ("denied" in access) return access.denied;
    try {
      return c.json(await deps.invitations.list(websiteId) as object);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}

export function createWebsiteInvitation(deps: WebsiteControllerDeps) {
  return async (c: InvitationContext<"/:id/invitations">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "admin");
    if ("denied" in access) return access.denied;
    const parsed = await parseJson(c, invitationCreateSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const result = await deps.invitations.create(
        access.userId,
        access.role,
        websiteId,
        parsed.data,
      );
      return c.json(result as object, 201);
    } catch (error) {
      const status = (error as Error & { status?: number }).status ?? 400;
      return c.json(
        { error: error instanceof Error ? error.message : "failed" },
        status as ContentfulStatusCode,
      );
    }
  };
}

export function revokeWebsiteInvitation(deps: WebsiteControllerDeps) {
  return async (c: InvitationContext<"/:id/invitations/:invitation_id">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "admin");
    if ("denied" in access) return access.denied;
    try {
      await deps.invitations.revoke(websiteId, c.req.param("invitation_id"));
      return c.body(null, 204);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}
