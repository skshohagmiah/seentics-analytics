import { automationsLane, profilesLane } from "./ingest-lane";
import type { WebsitesModule } from "../websites/interfaces";
import type { AutomationsModule } from "./interfaces";
import { AutomationUsageCounter } from "./services/usage-count.service";
import { PostgresAutomationRepository } from "./repositories/postgres-automation.repository";
import { createAutomationRoutes } from "./routes";
import { AutomationIngestService } from "./services/automation-ingest.service";
import { AutomationService } from "./services/automation.service";
import { AutomationEvaluationService } from "./services/evaluate.service";
import { AutomationRetentionPurge } from "./services/retention-purge.service";
import { VisitorProfileService } from "./services/visitor-profile.service";

/** Build the automations module. */
export function initAutomationsModule(deps: {
  websitesModule: WebsitesModule;
}): AutomationsModule {
  const automations = new AutomationService(
    new PostgresAutomationRepository(),
    deps.websitesModule.query,
  );

  const triggers = new AutomationIngestService();
  const visitorProfiles = new VisitorProfileService();

  return {
    lanes: {
      automations: automationsLane(triggers),
      profiles: profilesLane(visitorProfiles),
    },

    trackerSettings: automations,
    // Built here so it publishes onto the real bus. An evaluation service holding its
    // own bus would fire `automation.action_executed` at nobody.
    evaluation: new AutomationEvaluationService(),
    triggers,
    visitorProfiles,
    retention: new AutomationRetentionPurge(),
    usage: new AutomationUsageCounter(),
    routes: createAutomationRoutes({
      automations,
      websites: deps.websitesModule.accessChecks,
    }),
  };
}
