import { sql } from "../../../db";
import type {
  WebsitePrivacySettings,
  WebsitePrivacySettingsService,
} from "../interfaces";

type PrivacyRow = {
  ip_anonymization: WebsitePrivacySettings["ipAnonymization"];
  respect_dnt: boolean;
  consent_mode: WebsitePrivacySettings["consentMode"];
  data_retention_days: number | null;
};

const defaults: WebsitePrivacySettings = {
  ipAnonymization: "none",
  respectDnt: false,
  consentMode: "cookieless",
  dataRetentionDays: null,
};

function present(row: PrivacyRow | undefined): WebsitePrivacySettings {
  return row
    ? {
        ipAnonymization: row.ip_anonymization,
        respectDnt: row.respect_dnt,
        consentMode: row.consent_mode,
        dataRetentionDays: row.data_retention_days,
      }
    : defaults;
}

export class PostgresWebsitePrivacyService
  implements WebsitePrivacySettingsService
{
  async get(websiteId: string): Promise<WebsitePrivacySettings> {
    const rows = await sql<[PrivacyRow?]>`
      SELECT ip_anonymization, respect_dnt, consent_mode, data_retention_days
      FROM website_privacy_settings
      WHERE site_id = ${websiteId}
      LIMIT 1
    `;
    return present(rows[0]);
  }

  async save(
    websiteId: string,
    ownerUserId: string,
    settings: WebsitePrivacySettings,
  ): Promise<WebsitePrivacySettings> {
    const rows = await sql<[PrivacyRow]>`
      INSERT INTO website_privacy_settings (site_id, user_id, ip_anonymization, respect_dnt, consent_mode, data_retention_days)
      VALUES (${websiteId}, ${ownerUserId}::uuid, ${settings.ipAnonymization}, ${settings.respectDnt}, ${settings.consentMode}, ${settings.dataRetentionDays})
      ON CONFLICT (site_id) DO UPDATE SET
        user_id = EXCLUDED.user_id, ip_anonymization = EXCLUDED.ip_anonymization,
        respect_dnt = EXCLUDED.respect_dnt, consent_mode = EXCLUDED.consent_mode,
        data_retention_days = EXCLUDED.data_retention_days, updated_at = NOW()
      RETURNING ip_anonymization, respect_dnt, consent_mode, data_retention_days
    `;
    return present(rows[0]);
  }
}
