import type { WebsiteQuery } from "../../websites/interfaces";
import type { AutomationCrud, AutomationInsights } from "../interfaces";

export type AutomationControllerDeps = {
  automationCrud: AutomationCrud;
  automationInsights: AutomationInsights;
  websites: WebsiteQuery;
};
