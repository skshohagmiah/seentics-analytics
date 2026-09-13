import type { AutomationRepository, AutomationRow, AutomationTrackerSettings } from "../interfaces";

/** Active automation definitions used by anonymous tracker initialization. */
export class TrackerAutomationSettingsService implements AutomationTrackerSettings {
  constructor(private readonly repository: AutomationRepository) {}

  activeFor(websiteId: string): Promise<AutomationRow[]> {
    return this.repository.listActive(websiteId);
  }
}
