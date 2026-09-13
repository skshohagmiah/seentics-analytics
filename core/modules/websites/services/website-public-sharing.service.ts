import { randomHex } from "../lib/ids";
import type { WebsiteMutations, WebsiteRepository } from "../interfaces";

/** Enable and revoke public dashboard share identifiers. */
export class WebsitePublicSharingService implements Pick<WebsiteMutations, "setPublicSharing"> {
  constructor(
    private readonly repository: WebsiteRepository,
    private readonly onChanged: (websiteId: string) => void,
  ) {}

  async setPublicSharing(websiteId: string, enabled: boolean): Promise<string | null> {
    if (!enabled) {
      const result = await this.repository.setPublicShareId(websiteId, null);
      this.onChanged(websiteId);
      return result;
    }
    const existing = await this.repository.findById(websiteId);
    if (existing?.publicShareId) return existing.publicShareId;
    const shareId = await this.repository.setPublicShareId(websiteId, randomHex(12));
    this.onChanged(websiteId);
    return shareId;
  }
}
