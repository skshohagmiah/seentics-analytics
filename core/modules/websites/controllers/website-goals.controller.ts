import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseJson, validationErrorResponse } from "../../../platform/validation";
import { goalCreateSchema, goalPatchSchema } from "../validators/website.schema";
import { requireWebsiteAccess, websiteDenied } from "./website-access";
import type { WebsiteControllerDeps } from "./website-controller.types";

type GoalContext<Path extends string> = Context<{ Variables: AuthVars }, Path>;

export function listWebsiteGoals(deps: WebsiteControllerDeps) {
  return async (c: GoalContext<"/:id/goals">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "viewer");
    if ("denied" in access) return access.denied;
    try {
      return c.json(await deps.goals.listWebsiteGoals(websiteId) as object);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}

export function createWebsiteGoal(deps: WebsiteControllerDeps) {
  return async (c: GoalContext<"/:id/goals">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "member");
    if ("denied" in access) return access.denied;
    const parsed = await parseJson(c, goalCreateSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const result = await deps.goals.createWebsiteGoal(websiteId, parsed.data);
      return c.json(result as object, 201);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}

export function updateWebsiteGoal(deps: WebsiteControllerDeps) {
  return async (c: GoalContext<"/:id/goals/:goal_id">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "member");
    if ("denied" in access) return access.denied;
    const parsed = goalPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationErrorResponse(c, parsed.error);
    try {
      const result = await deps.goals.updateWebsiteGoal(
        websiteId,
        c.req.param("goal_id"),
        parsed.data,
      );
      return result ? c.json(result as object) : c.json({ error: "not found" }, 404);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}

export function deleteWebsiteGoal(deps: WebsiteControllerDeps) {
  return async (c: GoalContext<"/:id/goals/:goal_id">) => {
    const websiteId = c.req.param("id");
    const access = await requireWebsiteAccess(c, deps, websiteId, "member");
    if ("denied" in access) return access.denied;
    try {
      await deps.goals.deleteWebsiteGoal(websiteId, c.req.param("goal_id"));
      return c.body(null, 204);
    } catch (error) {
      return websiteDenied(c, error);
    }
  };
}
