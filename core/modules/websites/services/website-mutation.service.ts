import type {
  CreateWebsiteInput,
  UpdateWebsiteInput,
  Website,
  WebsiteMutations,
  WebsiteRepository,
} from "../interfaces";

/** Website creation, settings updates, and deletion. */
export class WebsiteMutationService implements Pick<WebsiteMutations, "create" | "update" | "delete"> {
  constructor(
    private readonly repository: WebsiteRepository,
    private readonly onChanged: (websiteId: string) => void,
  ) {}

  create(ownerId: string, input: CreateWebsiteInput): Promise<Website> {
    return this.repository.create(ownerId, input);
  }

  async update(websiteId: string, input: UpdateWebsiteInput): Promise<Website | null> {
    const updated = await this.repository.update(websiteId, input);
    if (updated) this.onChanged(websiteId);
    return updated;
  }

  async delete(websiteId: string): Promise<boolean> {
    const deleted = await this.repository.delete(websiteId);
    if (deleted) this.onChanged(websiteId);
    return deleted;
  }
}
