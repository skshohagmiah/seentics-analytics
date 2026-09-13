import type {
  CreateFunnelInput,
  Funnel,
  FunnelMutations,
  FunnelQuery,
  UpdateFunnelInput,
} from "../interfaces";
import {
  deleteFunnel,
  deleteFunnels,
  findFunnel,
  insertFunnel,
  listFunnels,
  updateFunnel,
} from "../repositories/funnel.repository";

/** CRUD for funnel definitions. The controller supplies an authorized website id. */
export class FunnelDefinitionService implements FunnelQuery, FunnelMutations {
  list(websiteId: string): Promise<Funnel[]> {
    return listFunnels(websiteId);
  }

  get(websiteId: string, funnelId: string): Promise<Funnel | null> {
    return findFunnel(websiteId, funnelId);
  }

  create(websiteId: string, userId: string, input: CreateFunnelInput): Promise<Funnel> {
    return insertFunnel(websiteId, userId, input);
  }

  update(
    websiteId: string,
    funnelId: string,
    input: UpdateFunnelInput,
  ): Promise<Funnel | null> {
    return updateFunnel(websiteId, funnelId, input);
  }

  async remove(websiteId: string, funnelId: string): Promise<void> {
    await deleteFunnel(websiteId, funnelId);
  }

  async bulkRemove(websiteId: string, funnelIds: string[]): Promise<void> {
    if (funnelIds.length === 0) return;
    await deleteFunnels(websiteId, funnelIds);
  }
}
