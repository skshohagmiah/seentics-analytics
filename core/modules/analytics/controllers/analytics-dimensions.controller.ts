import { analyticsRead } from "./analytics-access";
import type { AnalyticsControllerDeps } from "./analytics-controller.types";

export const getTopPages = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getPages(websiteRef, query));
export const getTopReferrers = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getReferrers(websiteRef, query));
export const getTopSources = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getSources(websiteRef, query));
export const getTopBrowsers = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getBrowsers(websiteRef, query));
export const getTopDevices = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getDevices(websiteRef, query));
export const getTopOperatingSystems = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getOperatingSystems(websiteRef, query));
export const getTopCountries = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getCountries(websiteRef, query));
export const getTopCities = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getCities(websiteRef, query));
export const getTopLanguages = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getLanguages(websiteRef, query));
export const getTopResolutions = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getResolutions(websiteRef, query));
export const getGeolocationBreakdown = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getGeolocation(websiteRef, query));
export const getPageUtmBreakdown = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getPageUtmBreakdown(websiteRef, query));
export const getDimensionsBulk = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dimensions.getDimensionsBulk(websiteRef, query));
