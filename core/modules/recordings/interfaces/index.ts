/**
 * Public contracts for the recordings module.
 *
 * Note the naming split documented in `recording.interface.ts`: the domain says
 * "recording", the HTTP path and the `session_replays` table still say "replay".
 */
export type {
  SessionMetaRow,
  RecordingChunkUrl,
  RecordingDetail,
  RecordingDetailMeta,
  RecordingIngest,
  RecordingMutations,
  RecordingQuery,
  RecordingSummary,
  SessionListFilters,
  SessionListSummary,
} from "./recording.interface";

/** The whole module surface, as a peer receives it at composition time. */
export type { RecordingsModule } from "./recordings.module";

export type { RecordingRawReads } from "./recording.interface";
