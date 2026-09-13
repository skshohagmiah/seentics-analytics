import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseJson, validationErrorResponse } from "../../../platform/validation";
import type { CreateAutomationInput, UpdateAutomationInput } from "../interfaces";
import {
  automationsBulkDeleteSchema,
  automationsPatchBodySchema,
  automationsUpsertBodySchema,
} from "../validators/automation.schema";
import { automationResponse, requireAutomationAccess } from "./automation-access";
import type { AutomationControllerDeps } from "./automation-controller.types";

type AutomationContext<Path extends string> = Context<{ Variables: AuthVars }, Path>;

export function listAutomations(deps: AutomationControllerDeps) {
  return async (c: AutomationContext<"/:website_id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireAutomationAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    return automationResponse(c, await deps.automationCrud.list(websiteRef));
  };
}

export function createAutomation(deps: AutomationControllerDeps) {
  return async (c: AutomationContext<"/:website_id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireAutomationAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const raw = await c.req.json().catch(() => null);
    const parsed = automationsUpsertBodySchema.safeParse(raw);
    if (!parsed.success) return validationErrorResponse(c, parsed.error);
    const data = await deps.automationCrud.create(
      websiteRef,
      access.userId,
      parsed.data as unknown as CreateAutomationInput,
    );
    return c.json({ data }, 201);
  };
}

export function bulkDeleteAutomations(deps: AutomationControllerDeps) {
  return async (c: AutomationContext<"/:website_id/bulk-delete">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireAutomationAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const parsed = await parseJson(c, automationsBulkDeleteSchema);
    if (!parsed.ok) return parsed.res;
    await deps.automationCrud.bulkDelete(websiteRef, parsed.data.ids ?? []);
    return c.body(null, 204);
  };
}

export function getAutomation(deps: AutomationControllerDeps) {
  return async (c: AutomationContext<"/:website_id/:id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireAutomationAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    return automationResponse(c, await deps.automationCrud.get(websiteRef, c.req.param("id")));
  };
}

export function updateAutomation(deps: AutomationControllerDeps) {
  return async (c: AutomationContext<"/:website_id/:id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireAutomationAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const raw = await c.req.json().catch(() => null);
    const parsed = automationsPatchBodySchema.safeParse(raw);
    if (!parsed.success) return validationErrorResponse(c, parsed.error);
    const data = await deps.automationCrud.update(
      websiteRef,
      c.req.param("id"),
      parsed.data as unknown as UpdateAutomationInput,
    );
    return automationResponse(c, data);
  };
}

export function deleteAutomation(deps: AutomationControllerDeps) {
  return async (c: AutomationContext<"/:website_id/:id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireAutomationAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    await deps.automationCrud.remove(websiteRef, c.req.param("id"));
    return c.body(null, 204);
  };
}
