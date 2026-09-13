/**
 * Public contracts for the websites module.
 *
 * Peer modules should import from here and from nowhere deeper — the service and
 * repository implementations are internal. `WebsitesModule` is the whole surface and
 * what a peer receives at composition time; `WebsiteQuery` is the one capability
 * almost every consumer actually uses.
 */
export type { WebsitesModule } from "./websites.module";
export type {
  CreateWebsiteInput,
  UpdateWebsiteInput,
  Website,
  WebsiteMutations,
  WebsitePublicSharing,
  WebsiteQuery,
  WebsiteRole,
  WebsiteSettings,
  WebsiteTrafficReads,
  WebsiteWithTraffic,
} from "./website.interface";

/** Values, not types — the role predicates peer modules gate their deletes on. */
export { normalizeWebsiteRole, roleAtLeast, roleCanDeleteData } from "./website.interface";

export type { WebsiteRepository } from "./website-repository.interface";

export type { WebsiteInvitations } from "./website-invitations.interface";

export type {
  WebsiteGoalOperations,
  WebsiteInvitationOperations,
  WebsiteMemberOperations,
} from "./website-administration.interface";

export type {
  WebsitePrivacySettings,
  WebsitePrivacySettingsService,
} from "./website-privacy.interface";

export type {
  TrackerGoal,
  TrackerWebsites,
  WebsiteTrackerRow,
} from "./tracker-website.interface";
