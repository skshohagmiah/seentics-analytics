import type { UserDirectory } from "../../auth/interfaces";
import type {
  WebsiteGoalOperations,
  WebsiteInvitationOperations,
  WebsiteMemberOperations,
  WebsiteMutations,
  WebsitePrivacySettingsService,
  WebsiteQuery,
  WebsiteTrafficReads,
} from "../interfaces";

export type WebsiteControllerDeps = {
  websites: WebsiteQuery;
  traffic: WebsiteTrafficReads;
  mutations: Pick<WebsiteMutations, "create" | "update" | "delete">;
  sharing: Pick<WebsiteMutations, "setPublicSharing">;
  users: UserDirectory;
  goals: WebsiteGoalOperations;
  members: WebsiteMemberOperations;
  invitations: WebsiteInvitationOperations;
  privacy: WebsitePrivacySettingsService;
};
