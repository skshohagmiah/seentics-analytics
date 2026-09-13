import type { LaneSpec } from "../../ingest/interfaces";
import type { AuthedRouter } from "../../../platform/http/router";
import type { UsageCounter } from "../../../platform/usage";
import type { RetentionPurge } from "../../../platform/retention";
import type {
  AutomationEvaluation,
  AutomationTrackerSettings,
  AutomationTriggerWriter,
  VisitorProfileWriter,
} from "./index";

/** Everything the automations module offers. */
export interface AutomationsModule {
  /** This module's ingest lanes — trigger rows and visitor profiles. */
  lanes: { automations: LaneSpec; profiles: LaneSpec };

  /** Active automations for the tracker's `/init`. One indexed read per session. */
  trackerSettings: AutomationTrackerSettings;

  /**
   * Server-side trigger evaluation, for the ingest edge.
   *
   * The only surface here with outbound side effects — it can fire a webhook — which
   * is why it is separate from the read capabilities either side of it.
   */
  evaluation: AutomationEvaluation;

  /** Where ingest hands a flushed batch of trigger rows. */
  triggers: AutomationTriggerWriter;

  /**
   * Where ingest hands the visitor profile built from a `/collect` batch.
   *
   * Separate from `triggers` because it is written per request rather than per flush,
   * and it is what gives conditions anything to say about the person rather than the page.
   */
  visitorProfiles: VisitorProfileWriter;

  /** Deletion of this module's own rows. */
  retention: RetentionPurge;

  /** This module's contribution to the per-user usage report. */
  usage: UsageCounter;

  routes: AuthedRouter;
}
