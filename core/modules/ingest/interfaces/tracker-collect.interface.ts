import type { TrackerCollectBody } from "../../../platform/lib/api-types";
import type { WebsiteTrackerRow } from "../../websites/interfaces";

export type ProcessTrackerCollectInput = {
  body: TrackerCollectBody;
  website: WebsiteTrackerRow;
  websiteParam: string;
  origin: string;
  headers: Headers;
  clientIp: string;
  diagnosticLog: boolean;
};

export type ProcessTrackerCollectResult =
  | { kind: "empty" }
  | { kind: "privacy-disabled" }
  | { kind: "processed"; queued: number };

export interface TrackerCollectService {
  process(input: ProcessTrackerCollectInput): ProcessTrackerCollectResult;
}
