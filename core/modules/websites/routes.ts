import { Hono } from "hono";
import { authMiddleware, type AuthVars } from "../../platform/middleware/auth";
import type { WebsiteControllerDeps } from "./controllers/website-controller.types";
import {
  createWebsite,
  deleteWebsite,
  getWebsite,
  listWebsites,
  updateWebsite,
} from "./controllers/website-crud.controller";
import {
  createWebsiteGoal,
  deleteWebsiteGoal,
  listWebsiteGoals,
  updateWebsiteGoal,
} from "./controllers/website-goals.controller";
import {
  createWebsiteInvitation,
  listWebsiteInvitations,
  revokeWebsiteInvitation,
} from "./controllers/website-invitations.controller";
import {
  addWebsiteMember,
  getWebsiteRole,
  listWebsiteMembers,
  removeWebsiteMember,
  updateWebsiteMemberRole,
} from "./controllers/website-members.controller";
import {
  getWebsitePrivacy,
  updateWebsitePrivacy,
} from "./controllers/website-privacy.controller";
import { updateWebsiteSharing } from "./controllers/website-sharing.controller";

export function createWebsiteRoutes(deps: WebsiteControllerDeps) {
  const routes = new Hono<{ Variables: AuthVars }>();
  routes.use("*", authMiddleware);
  routes.get("/", listWebsites(deps));
  routes.post("/", createWebsite(deps));
  routes.get("/:id", getWebsite(deps));
  routes.put("/:id", updateWebsite(deps));
  routes.delete("/:id", deleteWebsite(deps));
  routes.post("/:id/share", updateWebsiteSharing(deps));
  routes.get("/:id/goals", listWebsiteGoals(deps));
  routes.post("/:id/goals", createWebsiteGoal(deps));
  routes.patch("/:id/goals/:goal_id", updateWebsiteGoal(deps));
  routes.delete("/:id/goals/:goal_id", deleteWebsiteGoal(deps));
  routes.get("/:id/my-role", getWebsiteRole(deps));
  routes.get("/:id/members", listWebsiteMembers(deps));
  routes.post("/:id/members", addWebsiteMember(deps));
  routes.delete("/:id/members/:user_id", removeWebsiteMember(deps));
  routes.put("/:id/members/:user_id/role", updateWebsiteMemberRole(deps));
  routes.get("/:id/invitations", listWebsiteInvitations(deps));
  routes.post("/:id/invitations", createWebsiteInvitation(deps));
  routes.delete("/:id/invitations/:invitation_id", revokeWebsiteInvitation(deps));
  routes.get("/:websiteId/privacy", getWebsitePrivacy(deps));
  routes.put("/:websiteId/privacy", updateWebsitePrivacy(deps));
  return routes;
}
