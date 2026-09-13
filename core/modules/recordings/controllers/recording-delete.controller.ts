import type { Context } from "hono";
import { log } from "../../../platform/lib/logger";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseJson } from "../../../platform/validation";
import { replayBatchDeleteSchema } from "../validators/recording.schema";
import { requireRecordingAccess } from "./recording-access";
import type { RecordingControllerDeps } from "./recording-controller.types";

const recordingLog = log.child({ category: "recordings" });

export function deleteRecordings(deps: RecordingControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id/batch">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireRecordingAccess(c, deps, websiteRef, true);
    if ("denied" in access) return access.denied;
    const parsed = await parseJson(c, replayBatchDeleteSchema);
    if (!parsed.ok) return parsed.res;
    try {
      await deps.recordingDeletion.batchDelete(websiteRef, parsed.data.sessionIds);
      return c.json({ message: "sessions deleted" });
    } catch (error) {
      recordingLog.error({
        msg: "recording_delete_failed",
        website_id: websiteRef,
        err: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to delete sessions" }, 500);
    }
  };
}
