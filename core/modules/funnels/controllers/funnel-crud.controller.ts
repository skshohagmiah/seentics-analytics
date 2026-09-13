import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseJson, validationErrorResponse } from "../../../platform/validation";
import type { CreateFunnelInput, UpdateFunnelInput } from "../interfaces";
import { funnelsBulkDeleteSchema, funnelsUpsertBodySchema } from "../validators/funnel.schema";
import { funnelFailure, requireFunnelAccess } from "./funnel-access";
import type { FunnelControllerDeps } from "./funnel-controller.types";

type FunnelContext<Path extends string> = Context<{ Variables: AuthVars }, Path>;

export function listFunnels(deps: FunnelControllerDeps) {
  return async (c: FunnelContext<"/:website_id/funnels">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireFunnelAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    try {
      return c.json({ data: await deps.definitions.list(websiteRef) });
    } catch (error) {
      return funnelFailure(c, "list", websiteRef, error);
    }
  };
}

export function createFunnel(deps: FunnelControllerDeps) {
  return async (c: FunnelContext<"/:website_id/funnels">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireFunnelAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const raw = await c.req.json().catch(() => null);
    const parsed = funnelsUpsertBodySchema.safeParse(raw);
    if (!parsed.success) return validationErrorResponse(c, parsed.error);
    try {
      const data = await deps.definitions.create(
        websiteRef,
        access.userId,
        parsed.data as CreateFunnelInput,
      );
      return c.json({ data }, 201);
    } catch (error) {
      return funnelFailure(c, "create", websiteRef, error);
    }
  };
}

export function bulkDeleteFunnels(deps: FunnelControllerDeps) {
  return async (c: FunnelContext<"/:website_id/funnels/bulk-delete">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireFunnelAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const parsed = await parseJson(c, funnelsBulkDeleteSchema);
    if (!parsed.ok) return parsed.res;
    try {
      await deps.definitions.bulkRemove(websiteRef, parsed.data.ids);
      return c.body(null, 204);
    } catch (error) {
      return funnelFailure(c, "bulk_delete", websiteRef, error);
    }
  };
}

export function getFunnel(deps: FunnelControllerDeps) {
  return async (c: FunnelContext<"/:website_id/funnels/:funnel_id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireFunnelAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    try {
      const data = await deps.definitions.get(websiteRef, c.req.param("funnel_id"));
      return data ? c.json({ data }) : c.json({ error: "not found" }, 404);
    } catch (error) {
      return funnelFailure(c, "get", websiteRef, error);
    }
  };
}

export function updateFunnel(deps: FunnelControllerDeps) {
  return async (c: FunnelContext<"/:website_id/funnels/:funnel_id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireFunnelAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const raw = await c.req.json().catch(() => null);
    const parsed = funnelsUpsertBodySchema.safeParse(raw);
    if (!parsed.success) return validationErrorResponse(c, parsed.error);
    try {
      const data = await deps.definitions.update(
        websiteRef,
        c.req.param("funnel_id"),
        parsed.data as UpdateFunnelInput,
      );
      return data ? c.json({ data }) : c.json({ error: "not found" }, 404);
    } catch (error) {
      return funnelFailure(c, "update", websiteRef, error);
    }
  };
}

export function deleteFunnel(deps: FunnelControllerDeps) {
  return async (c: FunnelContext<"/:website_id/funnels/:funnel_id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireFunnelAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    try {
      await deps.definitions.remove(websiteRef, c.req.param("funnel_id"));
      return c.body(null, 204);
    } catch (error) {
      return funnelFailure(c, "remove", websiteRef, error);
    }
  };
}
