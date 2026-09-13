import type { Funnel, FunnelTrackerConfig } from "../interfaces";
import { listActiveFunnels } from "../repositories/funnel.repository";

/** Read-only active funnel configuration exposed to tracker endpoints. */
export class TrackerFunnelConfigService implements FunnelTrackerConfig {
  activeForTracker(websiteId: string): Promise<Funnel[]> {
    return listActiveFunnels(websiteId);
  }
}
