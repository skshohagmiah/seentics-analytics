import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseJson } from "../../../platform/validation";
import { memberAddSchema, memberRoleSchema } from "../validators/website.schema";
import { requireWebsiteAccess, websiteDenied } from "./website-access";
import type { WebsiteControllerDeps } from "./website-controller.types";

type MemberContext<Path extends string> = Context<{ Variables: AuthVars }, Path>;

export function getWebsiteRole(deps: WebsiteControllerDeps) {
  return async (c: MemberContext<"/:id/my-role">) => {
    const access = await requireWebsiteAccess(c, deps, c.req.param("id"), "viewer");
    if ("denied" in access) return access.denied;
    return c.json({ data: { role: access.role } });
  };
}

export function listWebsiteMembers(deps: WebsiteControllerDeps) {
  return async (c: MemberContext<"/:id/members">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "viewer");
    if ("denied" in access) return access.denied;
    try {
      return c.json(await deps.members.list(websiteId) as object);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}

export function addWebsiteMember(deps: WebsiteControllerDeps) {
  return async (c: MemberContext<"/:id/members">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "admin");
    if ("denied" in access) return access.denied;
    const parsed = await parseJson(c, memberAddSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const result = await deps.members.add(websiteId, access.role, parsed.data);
      return c.json(result as object, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "failed" }, 400);
    }
  };
}

export function removeWebsiteMember(deps: WebsiteControllerDeps) {
  return async (c: MemberContext<"/:id/members/:user_id">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "admin");
    if ("denied" in access) return access.denied;
    try {
      await deps.members.remove(websiteId, access.userId, access.role, c.req.param("user_id"));
      return c.body(null, 204);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}

export function updateWebsiteMemberRole(deps: WebsiteControllerDeps) {
  return async (c: MemberContext<"/:id/members/:user_id/role">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "admin");
    if ("denied" in access) return access.denied;
    const parsed = await parseJson(c, memberRoleSchema);
    if (!parsed.ok) return parsed.res;
    try {
      await deps.members.updateRole(
        websiteId,
        access.userId,
        access.role,
        c.req.param("user_id"),
        parsed.data.role,
      );
      return c.body(null, 204);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}
