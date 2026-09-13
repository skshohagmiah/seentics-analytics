import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { log } from "../../../platform/lib/logger";
import type { AuthVars } from "../../../platform/middleware/auth";
import { requireRecordingAccess } from "./recording-access";
import type { RecordingControllerDeps } from "./recording-controller.types";

const recordingLog = log.child({ category: "recordings" });

export function getRecording(deps: RecordingControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id/:session_id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireRecordingAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const sessionId = c.req.param("session_id");
    try {
      const detail = await deps.recordingDetails.getSessionDetail(websiteRef, sessionId);
      return c.json(detail.body, detail.status as ContentfulStatusCode);
    } catch (error) {
      recordingLog.error({
        msg: "recording_load_failed",
        session_id: sessionId,
        website_id: websiteRef,
        err: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to load replay" }, 500);
    }
  };
}
