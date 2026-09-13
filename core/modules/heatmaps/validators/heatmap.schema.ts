import { z } from "zod";
import { zNonEmptyString } from "../../../platform/validation";

export const heatmapDataQuerySchema = z.object({
  page_path: zNonEmptyString.max(2048),
  event_type: z.enum(["click", "scroll"]).optional().default("click"),
});

export const heatmapSnapshotQuerySchema = z.object({
  page_path: zNonEmptyString.max(2048),
  /**
   * Which layout to render underneath the points. Backgrounds are stored per device
   * bucket because a responsive page reflows between them; anything unrecognised
   * (including the dashboard's "all devices") resolves to desktop.
   */
  device: z.enum(["desktop", "tablet", "mobile"]).optional(),
});

export const heatmapBulkDeleteSchema = z.object({
  pagePaths: z.array(zNonEmptyString.max(2048)).min(1).max(500),
});

