import type {
  Website,
  WebsitePublicSharing,
  WebsiteQuery,
  WebsiteRepository,
  WebsiteRole,
} from "../interfaces";

/** Read-only website and role queries. */
export class WebsiteQueryService implements WebsiteQuery, WebsitePublicSharing {
  constructor(private readonly repository: WebsiteRepository) {}

  getById(websiteId: string): Promise<Website | null> {
    return this.repository.findById(websiteId);
  }

  listOwnedBy(ownerId: string): Promise<Website[]> {
    return this.repository.listOwnedBy(ownerId);
  }

  getRole(websiteId: string, userId: string): Promise<WebsiteRole | null> {
    return this.repository.findRole(websiteId, userId);
  }

  resolvePublicShareId(publicShareId: string): Promise<{ websiteId: string } | null> {
    return this.repository.findByPublicShareId(publicShareId);
  }
}
