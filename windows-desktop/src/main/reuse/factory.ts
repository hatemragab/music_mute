import {
  YouTubeCommunityClient,
  type CommunitySocket,
} from "../../../../chrome-extension/src/companion/youtube-community-client.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import {
  FULL_TIMELINE_RECIPE_DIGEST,
  FULL_TIMELINE_PROFILE_ID,
  parseDownloadGrant,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import type { HostContext } from "../host-context.js";
import type { LibraryStore } from "../library/store.js";
import type { LibraryArtifactCache } from "../library/artifacts.js";
import type { LibraryPins } from "../library/pins.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import { readPrivateBytes } from "../prepare/private-files.js";
import { createCloudApi } from "../cloud/api.js";
import type { OutboxAccountPort } from "../outbox/api.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import { WindowsGuestCredentialStore } from "./guest-credentials.js";
import {
  WindowsGuestAdoption,
  type ReuseAdmissionPort,
} from "./guest-adoption.js";
import { WindowsReuseMedia } from "./media.js";
import { WindowsReuseController, type ReuseOptions } from "./controller.js";
import { parsePersonalPair } from "./pair.js";
import {
  WindowsCommunityPublisher,
  WindowsPublicationStore,
  WindowsPublicationMedia,
} from "./publication.js";
export function createWindowsReuse(options: {
  host: HostContext;
  store: LibraryStore;
  cache: LibraryArtifactCache;
  pins: LibraryPins;
  tools: Pick<WindowsPreparationOperations, "snapshotMediaTools">;
  admission: ReuseAdmissionPort;
  origin?: string;
  account?: OutboxAccountPort;
  current(scope: SessionAccountScope | null): boolean;
  fetch?: typeof fetch;
  socketFactory?: (url: string) => CommunitySocket;
  onCommunityReady?: ReuseOptions["onCommunityReady"];
  consumersAllowed?(): boolean;
}) {
  const community = options.origin
    ? new YouTubeCommunityClient(
        options.origin,
        new WindowsGuestCredentialStore(options.host),
        options.fetch,
        options.socketFactory,
      )
    : undefined;
  const media = new WindowsReuseMedia({
    host: options.host,
    tools: options.tools,
    admission: options.admission,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const adoption = new WindowsGuestAdoption({
    host: options.host,
    store: options.store,
    admission: options.admission,
    validate: (...args) => media.validate(...args),
  });
  const controller = new WindowsReuseController({
    store: options.store,
    cache: options.cache,
    pins: options.pins,
    current: options.current,
    ...(community ? { community } : {}),
    pair: async (entry, signal) => {
      signal.throwIfAborted();
      return parsePersonalPair(
        JSON.parse(
          (
            await readPrivateBytes(
              options.host,
              `personal\\results\\${entry.personalJobId}\\pair.json`,
              32768,
            )
          ).toString("utf8"),
        ),
        options.host.report.installationId,
        entry.personalJobId,
      );
    },
    account: {
      restore: async (job, scope, signal) => {
        options.account?.assertScope(scope);
        let cached = await options.cache.lookup(job, scope, signal);
        if (!cached) {
          if (!options.origin || !options.account)
            throw new Error("ACCOUNT_NOT_CONFIGURED");
          const api = createCloudApi({
            origin: options.origin,
            installationId: options.host.report.installationId,
            account: options.account,
            scope,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          });
          const grant = parseDownloadGrant(
            await api.request(
              {
                firebase_uid: scope.firebaseUid,
                session_generation: scope.generation,
              },
              `/jobs/${job.id}/download-grants`,
              "POST",
              { variant: "output" },
              signal,
            ),
          );
          cached = await options.cache.download(job, grant, scope, signal);
        }
        options.account?.assertScope(scope);
        if (!options.current(scope)) throw new Error("ACCOUNT_CHANGED");
        return {
          relativePath: cached.relativePath,
          artifactId: cached.artifactId,
          bytes: cached.bytes,
          sha256: cached.sha256,
          mime: cached.contentType,
          durationSeconds: cached.durationSeconds,
        };
      },
    },
    adopt: async (delivery, signal, assertCurrent) => {
      const downloaded = await media.download(delivery, signal, assertCurrent);
      try {
        return await adoption.adopt(
          {
            version: 1,
            profileId: FULL_TIMELINE_PROFILE_ID,
            modelDigest: MODEL.sha256,
            recipeDigest: FULL_TIMELINE_RECIPE_DIGEST,
            trimEnabled: false,
            denoiseEnabled: false,
            source: {
              kind: "community-youtube",
              videoId: delivery.video_id,
              provenance: delivery.provenance,
              sourceIdentityVerified: delivery.source_identity_verified,
              inputSha256: delivery.original.declaration.sha256,
              inputBytes: delivery.original.declaration.bytes,
            },
            originalSha256: delivery.original.declaration.sha256,
            vocalsSha256: delivery.vocals.declaration.sha256,
          },
          downloaded.original,
          downloaded.vocals,
          signal,
          assertCurrent,
        );
      } catch (error) {
        if (WindowsReuseMedia.shutdownPending(error)) downloaded.markUnsafe();
        throw error;
      } finally {
        await downloaded.close();
      }
    },
    ...(options.onCommunityReady
      ? { onCommunityReady: options.onCommunityReady }
      : {}),
  });
  const publisher = community
    ? new WindowsCommunityPublisher({
        ...(options.consumersAllowed
          ? { consumersAllowed: options.consumersAllowed }
          : {}),
        store: new WindowsPublicationStore(options.host),
        media: new WindowsPublicationMedia(
          options.host,
          options.cache,
          options.pins,
          options.fetch,
        ),
        client: community,
        identity: async () => {
          const identity = await options.host.native.processIdentity?.(
            process.pid,
          );
          if (!identity) throw new Error("COMMUNITY_OWNER_UNAVAILABLE");
          return identity;
        },
        processIdentity: async (pid) => {
          if (!options.host.native.processIdentity)
            throw new Error("COMMUNITY_OWNER_UNAVAILABLE");
          return options.host.native.processIdentity(pid);
        },
      })
    : undefined;
  return { controller, community, media, adoption, publisher };
}
