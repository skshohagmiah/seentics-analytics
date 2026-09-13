import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireUser, type AuthVars } from "../../../platform/middleware/auth";
import { roleAtLeast, type WebsiteRole } from "../interfaces";
import type { WebsiteControllerDeps } from "./website-controller.types";

export type WebsiteContext<Path extends string = string> = Context<{ Variables: AuthVars }, Path>;

export function requireWebsiteUser(c: WebsiteContext): string | Response {
  return requireUser(c) ?? c.json({ error: "unauthorized" }, 401);
}

export function websiteDenied(c: Context, error: unknown): Response {
  const status = (error as Error & { status?: number }).status ?? 403;
  return c.json({ error: "forbidden" }, status as ContentfulStatusCode);
}

export async function requireWebsiteAccess(
  c: WebsiteContext,
  deps: WebsiteControllerDeps,
  websiteId: string,
  minimum: WebsiteRole,
): Promise<{ userId: string; role: WebsiteRole } | { denied: Response }> {
  const userId = requireUser(c);
  if (!userId) return { denied: c.json({ error: "unauthorized" }, 401) };
  const role = await deps.websites.getRole(websiteId, userId);
  if (!role || !roleAtLeast(role, minimum)) {
    return { denied: c.json({ error: "forbidden" }, 403) };
  }
  return { userId, role };
}
