import type {
  ConsumerOwnedProcess,
  ConsumerProcessIdentity,
  WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { SessionRole } from "../../shared/session-contracts.js";
import type { StoreNodeIssuer } from "./store-node-issuer.js";

/** Non-secret fixed agent configuration; each child owns a separate config file. */
export interface SessionAgentConfiguration {
  version: 1;
  kind: "session-agent";
  installationProfile: "windows-user";
  /** Store generations come from the live OS inventory, never an archive receipt. */
  distribution?: "microsoft-store";
  release: string;
  releaseRoot: string;
  nativeSha256: string;
  personalRoot: string;
  fleetRoot: string;
  /** Small executable inventory captured after signed release verification. */
  launchFiles: Record<string, string>;
  backendOrigin?: string;
}
export interface SessionRuntimeContext {
  readonly distribution?: "microsoft-store";
  /** Only the private-branded Store context supplies this actual issuer. */
  readonly storeIssuer?: StoreNodeIssuer;
  configuration: SessionAgentConfiguration;
  native: WindowsConsumerNative;
  /** Fresh verified helper, for blocking server/client operations without guardian contention. */
  openNative(): Promise<WindowsConsumerNative>;
  /** A separate transport owns only this role's processing tree. */
  guardian(role: SessionRole): Promise<WindowsConsumerNative>;
  /** Exact role/nonce/Node birth plus native IsProcessInJob for the server helper. */
  verifyOwnedPeer(
    owner: ConsumerOwnedProcess,
    peer: ConsumerProcessIdentity,
  ): Promise<void>;
}
export interface SessionControlTicket {
  version: 1;
  owner: ConsumerOwnedProcess;
  server: ConsumerProcessIdentity;
  channel: string;
  nonce: string;
  expiresAt: number;
}
export interface SessionChildContext {
  readonly distribution?: "microsoft-store";
  readonly storeIssuer?: StoreNodeIssuer;
  releaseRoot: string;
  personalRoot: string;
  fleetRoot: string;
  role: SessionRole;
  ownershipNonce: string;
  native: WindowsConsumerNative;
  ownerIdentity: ConsumerProcessIdentity;
  openNative(): Promise<WindowsConsumerNative>;
}
