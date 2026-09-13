import { requireUser, type AuthVars } from "../../../platform/middleware/auth";
import type { Context } from "hono";
import { parseJson, validationErrorResponse } from "../../../platform/validation";
import { toUpdateWebsiteInput } from "../lib/patch-mapping";
import { presentWebsite, presentWebsites } from "../lib/website-presenter";
import { websiteCreateSchema, websitePatchSchema } from "../validators/website.schema";
import { requireWebsiteAccess, websiteDenied } from "./website-access";
import type { WebsiteControllerDeps } from "./website-controller.types";

type WebContext<Path extends string> = Context<{ Variables: AuthVars }, Path>;

export function listWebsites(deps: WebsiteControllerDeps) {
  return async (c: WebContext<"/">) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    return c.json({ data: presentWebsites(await deps.traffic.listOwnedWithTraffic(userId)) });
  };
}

export function createWebsite(deps: WebsiteControllerDeps) {
  return async (c: WebContext<"/">) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseJson(c, websiteCreateSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const website = await deps.mutations.create(userId, parsed.data);
      return c.json({ data: { website: presentWebsite(website) } }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "create failed" }, 400);
    }
  };
}

export function getWebsite(deps: WebsiteControllerDeps) {
  return async (c: WebContext<"/:id">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "viewer");
    if ("denied" in access) return access.denied;
    try {
      const website = await deps.traffic.getWithTraffic(websiteId);
      return website
        ? c.json({ data: presentWebsite(website) })
        : c.json({ error: "not found" }, 404);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}

export function updateWebsite(deps: WebsiteControllerDeps) {
  return async (c: WebContext<"/:id">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "admin");
    if ("denied" in access) return access.denied;
    const raw = await c.req.json().catch(() => null);
    const parsed = websitePatchSchema.safeParse(raw);
    if (!parsed.success) return validationErrorResponse(c, parsed.error);
    try {
      const website = await deps.mutations.update(websiteId, toUpdateWebsiteInput(parsed.data));
      return website
        ? c.json({ data: presentWebsite(website) })
        : c.json({ error: "not found" }, 404);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}

export function deleteWebsite(deps: WebsiteControllerDeps) {
  return async (c: WebContext<"/:id">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "owner");
    if ("denied" in access) return access.denied;
    try {
      await deps.mutations.delete(websiteId);
      return c.body(null, 204);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}
