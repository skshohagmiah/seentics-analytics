import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { automationResponse, requireAutomationAccess } from "./automation-access";
import type { AutomationControllerDeps } from "./automation-controller.types";

type DetailContext<Path extends string> = Context<{ Variables: AuthVars }, Path>;

function insight(
  deps: AutomationControllerDeps,
  load: (websiteRef: string, id: string) => Promise<unknown>,
) {
  return async (c: DetailContext<any>) => {
    const websiteRef = c.req.param("website_id") ?? "";
    const access = await requireAutomationAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    return automationResponse(c, await load(websiteRef, c.req.param("id") ?? ""));
  };
}

export function listAutomationExecutions(deps: AutomationControllerDeps) {
  return insight(deps, (websiteRef, id) => deps.automationInsights.executions(websiteRef, id));
}

export function toggleAutomation(deps: AutomationControllerDeps) {
  return insight(deps, (websiteRef, id) => deps.automationCrud.toggle(websiteRef, id));
}

export function getAutomationStats(deps: AutomationControllerDeps) {
  return insight(deps, (websiteRef, id) => deps.automationInsights.stats(websiteRef, id));
}

export function getAutomationDailyStats(deps: AutomationControllerDeps) {
  return insight(deps, (websiteRef, id) => deps.automationInsights.dailyStats(websiteRef, id));
}
