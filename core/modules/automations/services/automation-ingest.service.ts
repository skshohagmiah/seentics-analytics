import { applyBatchOnce } from "../../../platform/idempotency";
import type { AutomationTriggerQueued } from "../../../platform/lib/types";
import { ingestAutomationTriggersBatch } from "../repositories/automation-batch.repository";
import type { AutomationTriggerWriter } from "../interfaces";

/**
 * The ingest write path, as automations offers it.
 *
 * The marker matters more here than anywhere except heatmaps: a trigger row is what
 * frequency caps are charged against and what the dashboard counts as a firing, so a
 * replayed batch would both over-report and prematurely exhaust a cap.
 */
export class AutomationIngestService implements AutomationTriggerWriter {
  async writeTriggers(batchId: string, rows: AutomationTriggerQueued[]): Promise<void> {
    await applyBatchOnce(batchId, (tx) => ingestAutomationTriggersBatch(tx, rows));
  }
}
