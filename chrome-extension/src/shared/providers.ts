import type {
  JobSnapshot,
  MediaSource,
  ProviderId,
  StartPayload,
} from "./protocol.js";

/** Browser-facing providers hide native messaging versus authenticated cloud transport. */
export interface PlaybackProcessingProvider {
  readonly capabilities: ProviderCapabilities;
  start(
    request: StartPayload,
    onSnapshot: (snapshot: JobSnapshot) => void,
  ): Promise<void>;
  cancel(jobId: string): Promise<void>;
  resolveMedia(jobId: string): Promise<MediaSource>;
  close(): Promise<void>;
}
export interface ProviderCapabilities {
  id: ProviderId;
  available: boolean;
  requires_companion: boolean;
  requires_account: boolean;
  preserves_timeline: boolean;
}
export const PROVIDER_CAPABILITIES: readonly ProviderCapabilities[] = [
  {
    id: "LOCAL_MACOS",
    available: true,
    requires_companion: true,
    requires_account: false,
    preserves_timeline: true,
  },
  {
    id: "LOCAL_WINDOWS",
    available: false,
    requires_companion: true,
    requires_account: false,
    preserves_timeline: true,
  },
  {
    id: "ONLINE_MUSICMUTE",
    available: true,
    requires_companion: true,
    requires_account: true,
    preserves_timeline: true,
  },
];
