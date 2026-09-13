import type { WebsiteQuery } from "../../websites/interfaces";
import type {
  FunnelMutations,
  FunnelPerformance,
  FunnelQuery,
  FunnelTrackerConfig,
} from "../interfaces";

export type FunnelControllerDeps = {
  definitions: FunnelQuery & FunnelMutations;
  performance: FunnelPerformance;
  trackerConfig: FunnelTrackerConfig;
  websites: WebsiteQuery;
};
