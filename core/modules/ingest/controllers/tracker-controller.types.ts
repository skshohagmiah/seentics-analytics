import type {
  AutomationEvaluation,
  AutomationTrackerSettings,
} from "../../automations/interfaces";
import type { FunnelTrackerConfig } from "../../funnels/interfaces";
import type { HeatmapScreenshotCapture } from "../../heatmaps/interfaces";
import type { TrackerWebsites } from "../../websites/interfaces";
import type { TrackerCollectService } from "../interfaces";

export type TrackerControllerDeps = {
  collect: TrackerCollectService;
  automations: AutomationTrackerSettings;
  automationEvaluation: AutomationEvaluation;
  funnels: FunnelTrackerConfig;
  screenshots: HeatmapScreenshotCapture;
  trackerWebsites: TrackerWebsites;
};
