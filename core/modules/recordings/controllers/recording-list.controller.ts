import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseQuery } from "../../../platform/validation";
import { replayListQuerySchema } from "../validators/recording.schema";
import { requireRecordingAccess } from "./recording-access";
import type { RecordingControllerDeps } from "./recording-controller.types";

export function listRecordings(deps: RecordingControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireRecordingAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const query = parseQuery(c, replayListQuerySchema);
    if (!query.ok) return query.res;
    const data = query.data;
    const result = await deps.recordingList.listSessions(websiteRef, data.limit, data.offset, {
      search: data.search,
      device: data.device,
      hasErrors: data.has_errors,
      hasRageClicks: data.has_rage_clicks,
    });
    return c.json(result);
  };
}
