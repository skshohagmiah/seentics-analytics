import { automationsLane, profilesLane } from "./ingest-lane";
import type { WebsitesModule } from "../websites/interfaces";
import type { AutomationsModule } from "./interfaces";
import { AutomationUsageCounter } from "./services/usage-count.service";
import { PostgresAutomationRepository } from "./repositories/postgres-automation.repository";
import { createAutomationRoutes } from "./routes";
import { AutomationIngestService } from "./services/automation-ingest.service";
import { AutomationCrudService } from "./services/automation-crud.service";
import { AutomationInsightService } from "./services/automation-insight.service";
import { TrackerAutomationSettingsService } from "./services/tracker-automation-settings.service";
import { AutomationEvaluationService } from "./services/automation-evaluation.service";
import { AutomationRetentionPurge } from "./services/retention-purge.service";
import { VisitorProfileService } from "./services/visitor-profile.service";

/** Build the automations module. */
export function initAutomationsModule(deps: {
  websitesModule: WebsitesModule;
}): AutomationsModule {
  const repository = new PostgresAutomationRepository();
  const automationCrud = new AutomationCrudService(repository);
  const automationInsights = new AutomationInsightService(repository);
  const trackerSettings = new TrackerAutomationSettingsService(repository);

  const triggers = new AutomationIngestService();
  const visitorProfiles = new VisitorProfileService();

  return {
    lanes: {
      automations: automationsLane(triggers),
      profiles: profilesLane(visitorProfiles),
    },

    trackerSettings,
    // Built here so it publishes onto the real bus. An evaluation service holding its
    // own bus would fire `automation.action_executed` at nobody.
    evaluation: new AutomationEvaluationService(),
    triggers,
    visitorProfiles,
    retention: new AutomationRetentionPurge(),
    usage: new AutomationUsageCounter(),
    routes: createAutomationRoutes({
      automationCrud,
      automationInsights,
      websites: deps.websitesModule.accessChecks,
    }),
  };
}
