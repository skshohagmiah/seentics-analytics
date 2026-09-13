import type {
  AutomationCrud,
  AutomationListItem,
  AutomationRepository,
  AutomationRow,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "../interfaces";

/** Dashboard CRUD for automations on an already-authorized website. */
export class AutomationCrudService implements AutomationCrud {
  constructor(private readonly repository: AutomationRepository) {}

  list(websiteId: string): Promise<AutomationListItem[]> {
    return this.repository.listWithStats(websiteId);
  }

  create(websiteId: string, userId: string, input: CreateAutomationInput): Promise<AutomationRow> {
    return this.repository.create(websiteId, userId, input);
  }

  get(websiteId: string, automationId: string): Promise<AutomationRow | null> {
    return this.repository.findById(websiteId, automationId);
  }

  update(websiteId: string, automationId: string, patch: UpdateAutomationInput) {
    return this.repository.update(websiteId, automationId, patch);
  }

  async remove(websiteId: string, automationId: string): Promise<void> {
    await this.repository.delete(websiteId, automationId);
  }

  async bulkDelete(websiteId: string, automationIds: string[]): Promise<void> {
    if (automationIds.length === 0) return;
    await this.repository.deleteMany(websiteId, automationIds);
  }

  toggle(websiteId: string, automationId: string) {
    return this.repository.toggleActive(websiteId, automationId);
  }
}
