import type {
  AutomationDailyRuns,
  AutomationExecutionRow,
  AutomationInsights,
  AutomationRepository,
  AutomationStats,
} from "../interfaces";

const EXECUTION_LOG_LIMIT = 100;

/** Execution history and aggregates, isolated from automation mutations. */
export class AutomationInsightService implements AutomationInsights {
  constructor(private readonly repository: AutomationRepository) {}

  private async belongsToWebsite(websiteId: string, automationId: string): Promise<boolean> {
    return (await this.repository.findById(websiteId, automationId)) !== null;
  }

  async executions(
    websiteId: string,
    automationId: string,
  ): Promise<AutomationExecutionRow[] | null> {
    if (!(await this.belongsToWebsite(websiteId, automationId))) return null;
    return this.repository.listExecutions(automationId, EXECUTION_LOG_LIMIT);
  }

  async stats(websiteId: string, automationId: string): Promise<AutomationStats | null> {
    if (!(await this.belongsToWebsite(websiteId, automationId))) return null;
    return this.repository.getStats(automationId);
  }

  async dailyStats(
    websiteId: string,
    automationId: string,
  ): Promise<AutomationDailyRuns[] | null> {
    if (!(await this.belongsToWebsite(websiteId, automationId))) return null;
    return this.repository.getDailyRuns(automationId);
  }
}
