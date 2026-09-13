export type WebsitePrivacySettings = {
  ipAnonymization: "none" | "partial" | "full";
  respectDnt: boolean;
  consentMode: "cookieless" | "strict";
  dataRetentionDays: number | null;
};

/** Persistence-backed privacy settings after controller authorization. */
export interface WebsitePrivacySettingsService {
  get(websiteId: string): Promise<WebsitePrivacySettings>;
  save(
    websiteId: string,
    ownerUserId: string,
    settings: WebsitePrivacySettings,
  ): Promise<WebsitePrivacySettings>;
}
