import type { AnalyticsModule } from "../analytics/interfaces";
import type { AuthModule } from "../auth/interfaces";
import type { WebsitesModule } from "./interfaces";
import { WebsiteUsageCounter } from "./services/usage-count.service";
import { PostgresWebsiteRepository } from "./repositories/postgres-website.repository";
import { createWebsiteRoutes } from "./routes";
import { CachedWebsiteQuery } from "./services/cached-website-query.service";
import { TrackerWebsiteService } from "./services/tracker-website.service";
import { WebsiteRetentionSiteSource } from "./services/retention-sites.service";
import { WebsiteInvitationService } from "./services/website-invitation.service";
import { WebsiteMemberService } from "./services/website-member.service";
import { WebsiteMutationService } from "./services/website-mutation.service";
import { WebsitePublicSharingService } from "./services/website-public-sharing.service";
import { WebsiteQueryService } from "./services/website-query.service";
import { WebsiteTrafficService } from "./services/website-traffic.service";
import * as goals from "./services/website-goal.service";
import { PostgresWebsitePrivacyService } from "./services/postgres-website-privacy.service";

/**
 * Build the websites module.
 *
 * `analyticsModule` is a getter rather than the module, and it is the only place in
 * the system that needs one. Websites and analytics genuinely depend on each other — the
 * website list embeds pageview counts, and every analytics query resolves a website —
 * so one of the two has to be built before the other exists. Passing
 * `() => analyticsModule` lets websites go first: nothing calls it during construction, only
 * while serving a request.
 *
 * The alternatives were worse. A separate `traffic` port meant a second exported
 * function whose only job was to be constructible early, which read as ceremony.
 * Building websites in two phases left it half-initialised for two lines with nothing
 * in the type system saying so.
 */
export function initWebsitesModule(deps: {
  analyticsModule(): AnalyticsModule;
  /** For member names and invitation email checks — `users` belongs to auth. */
  authModule: AuthModule;
}): WebsitesModule {
  // `cached` is referenced before it is assigned, but only from inside a callback the
  // service invokes after a mutation — by which time the binding is initialised.
  const repository = new PostgresWebsiteRepository();
  const query = new WebsiteQueryService(repository);
  const cached = new CachedWebsiteQuery(query);
  const onChanged = (websiteId: string) => cached.invalidate(websiteId);
  const mutations = new WebsiteMutationService(repository, onChanged);
  const sharing = new WebsitePublicSharingService(repository, onChanged);
  const traffic = new WebsiteTrafficService(repository, deps.analyticsModule);
  const tracker = new TrackerWebsiteService();
  const invitations = new WebsiteInvitationService(deps.authModule.users);

  return {
    query: cached,
    accessChecks: query,
    sharing: query,
    invitations,
    trackerWebsites: tracker,

    // Its own routes take the uncached service: this is the module doing the mutating,
    // and it must read its own writes.
    usage: new WebsiteUsageCounter(),
    retentionSites: new WebsiteRetentionSiteSource(),
    routes: createWebsiteRoutes({
      websites: query,
      traffic,
      mutations,
      sharing,
      users: deps.authModule.users,
      goals,
      members: new WebsiteMemberService(deps.authModule.users),
      invitations,
      privacy: new PostgresWebsitePrivacyService(),
    }),

    // Tracker cache sizing comes from config, so it waits for `start` like any other
    // configured resource.
    start(cfg) {
      tracker.configure(cfg);
    },

    stop() {
      cached.clear();
    },
  };
}
