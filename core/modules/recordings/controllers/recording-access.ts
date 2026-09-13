import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireUser, type AuthVars } from "../../../platform/middleware/auth";
import { roleCanDeleteData, type WebsiteRole } from "../../websites/interfaces";
import type { RecordingControllerDeps } from "./recording-controller.types";

export async function requireRecordingAccess(
  c: Context<{ Variables: AuthVars }>,
  deps: RecordingControllerDeps,
  websiteRef: string,
  requireDelete = false,
): Promise<{ role: WebsiteRole } | { denied: Response }> {
  const userId = requireUser(c);
  if (!userId) return { denied: c.json({ error: "forbidden" }, 403) };
  const role = await deps.websites.getRole(websiteRef, userId);
  if (!role) return { denied: c.json({ error: "forbidden" }, 403 as ContentfulStatusCode) };
  if (requireDelete && !roleCanDeleteData(role)) {
    return {
      denied: c.json(
        { error: "your role on this website cannot delete recordings" },
        403 as ContentfulStatusCode,
      ),
    };
  }
  return { role };
}
