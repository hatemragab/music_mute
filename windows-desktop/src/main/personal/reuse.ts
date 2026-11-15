import { open } from "node:fs/promises";
import { win32 } from "node:path";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import {
  FULL_TIMELINE_PROFILE_ID,
  FULL_TIMELINE_RECIPE_DIGEST,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import { DesktopApiError } from "../../../../chrome-extension/src/companion/account-api.js";
import {
  YouTubeCommunityClient,
  type CommunityContribution,
} from "../../../../chrome-extension/src/companion/youtube-community-client.js";
import type { HostContext } from "../host-context.js";
import type { LibraryStore } from "../library/store.js";
import type { LibraryArtifactCache } from "../library/artifacts.js";
import type { LibraryPins } from "../library/pins.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import { WindowsGuestCredentialStore } from "../reuse/guest-credentials.js";
import {
  WindowsGuestAdoption,
  copyReuseArtifact,
  type ReuseAdmissionPort,
  type ReuseCopyArtifact,
} from "../reuse/guest-adoption.js";
import { WindowsReuseMedia } from "../reuse/media.js";
import {
  WindowsCommunityPublisher,
  WindowsPublicationMedia,
  WindowsPublicationStore,
} from "../reuse/publication.js";
import type { VerifiedPersonalPair } from "../reuse/pair.js";
import type { ReuseReceipt } from "../../shared/reuse-contracts.js";
import type { PersonalJobView } from "../../shared/personal-contracts.js";
import type {
  PersonalReuseHit,
  PersonalReusePort,
  PersonalRunContext,
} from "./controller.js";

function optionalUnavailable(error: unknown): boolean {
  return (
    error instanceof DesktopApiError &&
    ([401, 403, 404, 408, 429].includes(error.status) ||
      error.status >= 500 ||
      [
        "COMMUNITY_UNAVAILABLE",
        "COMMUNITY_SESSION_UNAVAILABLE",
        "GUEST_CREDENTIALS_UNAVAILABLE",
      ].includes(error.code))
  );
}
/** Guest authority is independent of Firebase. Only exact verified media can bypass acquisition/inference. */
export class WindowsPersonalReuse implements PersonalReusePort {
  private readonly community: YouTubeCommunityClient | undefined;
  private readonly media: WindowsReuseMedia;
  private readonly pairReader: WindowsPublicationMedia;
  readonly publisher: WindowsCommunityPublisher | undefined;
  private readonly reservations = new Map<string, CommunityContribution>();
  constructor(
    private readonly options: {
      host: HostContext;
      store: LibraryStore;
      cache: LibraryArtifactCache;
      pins: LibraryPins;
      admission: ReuseAdmissionPort;
      tools: Pick<WindowsPreparationOperations, "snapshotMediaTools">;
      backendOrigin?: string;
      fetch?: typeof fetch;
      community?: YouTubeCommunityClient;
      media?: WindowsReuseMedia;
    },
  ) {
    this.community =
      options.community ??
      (options.backendOrigin
        ? new YouTubeCommunityClient(
            options.backendOrigin,
            new WindowsGuestCredentialStore(options.host),
            options.fetch,
          )
        : undefined);
    this.media =
      options.media ??
      new WindowsReuseMedia({
        host: options.host,
        tools: options.tools,
        admission: options.admission,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    this.pairReader = new WindowsPublicationMedia(
      options.host,
      options.cache,
      options.pins,
      options.fetch,
    );
    if (this.community)
      this.publisher = new WindowsCommunityPublisher({
        store: new WindowsPublicationStore(options.host),
        media: this.pairReader,
        client: this.community,
        identity: async () => {
          const owner = await options.host.native.processIdentity?.(
            process.pid,
          );
          if (!owner) throw new Error("COMMUNITY_OWNER_UNAVAILABLE");
          return owner;
        },
        processIdentity: (pid) => {
          if (!options.host.native.processIdentity)
            throw new Error("COMMUNITY_OWNER_UNAVAILABLE");
          return options.host.native.processIdentity(pid);
        },
      });
  }
  private check(context: PersonalRunContext) {
    context.signal.throwIfAborted();
  }
  private async localSource(
    pair: VerifiedPersonalPair,
    kind: "original" | "vocals",
    context: PersonalRunContext,
  ) {
    const declaration = pair.entry[kind],
      artifact = await this.options.cache.local(
        pair.entry.personalJobId,
        declaration,
        kind === "vocals" ? "voice" : "original",
      ),
      pin = await this.options.pins.pin(artifact, "processing");
    try {
      if (
        pin.artifactId !== artifact.artifactId ||
        pin.relativePath !== artifact.relativePath ||
        pin.sha256 !== artifact.sha256
      )
        throw new Error("REUSE_PIN_INVALID");
      await this.options.cache.verify(artifact, context.signal);
      this.check(context);
      const file = await open(
        win32.join(this.options.host.personalRoot, artifact.relativePath),
        "r",
      );
      return {
        item: {
          file,
          declaration,
          extension:
            kind === "original" ? pair.filenames.original.slice(9) : "mp3",
        } satisfies ReuseCopyArtifact,
        release: async () => {
          try {
            await file.close();
          } finally {
            await pin.release();
          }
        },
      };
    } catch (error) {
      await pin.release();
      throw error;
    }
  }
  private pairHit(
    proof: ReuseReceipt,
    original: ReuseCopyArtifact,
    vocals: ReuseCopyArtifact,
    context: PersonalRunContext,
    validate: () => Promise<void>,
    release: () => Promise<void>,
  ): PersonalReuseHit {
    const adoption = new WindowsGuestAdoption({
      host: this.options.host,
      store: this.options.store,
      admission: this.options.admission,
      validate: async () => {
        this.check(context);
        await validate();
        this.check(context);
      },
    });
    let adopted:
      Promise<Awaited<ReturnType<WindowsGuestAdoption["adopt"]>>> | undefined;
    return {
      kind: "pair",
      release,
      adopt: async () => {
        this.check(context);
        adopted ??= adoption.adopt(
          proof,
          original,
          vocals,
          context.signal,
          () => this.check(context),
          {
            jobId: context.jobId,
            ownerId: context.ownerId,
            requestId: context.requestId,
            capturedAccountScope: context.scope,
          },
        );
        const pair = await adopted;
        this.check(context);
        return {
          original: pair.entry.original,
          vocals: pair.entry.vocals,
          ...(pair.timeline ? { timeline: pair.timeline } : {}),
        };
      },
    };
  }
  private async originalHit(
    item: ReuseCopyArtifact,
    source: ReuseReceipt["source"],
    context: PersonalRunContext,
    release: () => Promise<void>,
  ): Promise<PersonalReuseHit> {
    try {
      const relative = `personal\\jobs\\${context.jobId}\\shared-source.${item.extension}`;
      await copyReuseArtifact(
        this.options.host,
        item,
        relative,
        context.signal,
        () => this.check(context),
      );
      return {
        kind: "original",
        release,
        input: {
          path: win32.join(this.options.host.personalRoot, relative),
          name: item.declaration.name,
          bytes: item.declaration.bytes,
          sha256: item.declaration.sha256,
          sourceIdentity: source,
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
  async lookup(
    videoId: string,
    context: PersonalRunContext,
  ): Promise<PersonalReuseHit | null> {
    this.check(context);
    if (context.recipeId !== "kim-vocals-v2") return null;
    const snapshot = await this.options.store.snapshot(null);
    for (const entry of snapshot.guest.entries) {
      if (entry.catalog.video_id !== videoId || entry.catalog.trim_enabled)
        continue;
      let pair: VerifiedPersonalPair;
      try {
        pair = await this.pairReader.pair(entry.personalJobId, context.signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const proof = pair.reuse;
      if (
        !proof ||
        proof.source.kind === "file" ||
        proof.source.videoId !== videoId ||
        proof.originalSha256 !== entry.original.sha256 ||
        proof.vocalsSha256 !== entry.vocals.sha256
      )
        continue;
      let original: Awaited<ReturnType<WindowsPersonalReuse["localSource"]>>;
      try {
        original = await this.localSource(pair, "original", context);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        const vocals = await this.localSource(pair, "vocals", context);
        return this.pairHit(
          proof,
          original.item,
          vocals.item,
          context,
          async () => {
            // Trusted private receipt plus full descriptor checksum checks authorize cached source reuse.
            await this.options.cache.verify(
              await this.options.cache.local(
                entry.personalJobId,
                entry.original,
                "original",
              ),
              context.signal,
            );
            await this.options.cache.verify(
              await this.options.cache.local(
                entry.personalJobId,
                entry.vocals,
                "voice",
              ),
              context.signal,
            );
          },
          async () => {
            try {
              await vocals.release();
            } finally {
              await original.release();
            }
          },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          await original.release();
          throw error;
        }
        if (
          proof.source.inputSha256 !== original.item.declaration.sha256 ||
          proof.source.inputBytes !== original.item.declaration.bytes
        ) {
          await original.release();
          continue;
        }
        return this.originalHit(
          original.item,
          proof.source,
          context,
          original.release,
        );
      }
    }
    if (!this.community) return null;
    let delivery;
    try {
      delivery = await this.community.lookup(
        videoId,
        undefined,
        context.signal,
      );
    } catch (error) {
      this.check(context);
      if (optionalUnavailable(error)) return null;
      throw error;
    }
    this.check(context);
    if (delivery) {
      const downloaded = await this.media.download(
        delivery,
        context.signal,
        () => this.check(context),
      );
      const proof: ReuseReceipt = {
        version: 1,
        profileId: FULL_TIMELINE_PROFILE_ID,
        modelDigest: MODEL.sha256,
        recipeDigest: FULL_TIMELINE_RECIPE_DIGEST,
        trimEnabled: false,
        denoiseEnabled: false,
        source: {
          kind: "community-youtube",
          videoId,
          provenance: delivery.provenance,
          sourceIdentityVerified: delivery.source_identity_verified,
          inputSha256: delivery.original.declaration.sha256,
          inputBytes: delivery.original.declaration.bytes,
        },
        originalSha256: delivery.original.declaration.sha256,
        vocalsSha256: delivery.vocals.declaration.sha256,
      };
      return this.pairHit(
        proof,
        downloaded.original,
        downloaded.vocals,
        context,
        async () => {
          try {
            await this.media.validate(
              downloaded.original,
              downloaded.vocals,
              context.signal,
              () => this.check(context),
            );
          } catch (error) {
            if (WindowsReuseMedia.shutdownPending(error))
              downloaded.markUnsafe();
            throw error;
          }
        },
        downloaded.close,
      );
    }
    try {
      const reservation = await this.community.reserve(
        videoId,
        context.signal,
        context.requestId,
      );
      this.check(context);
      if (reservation.producer && reservation.state === "preparing") {
        this.reservations.set(context.jobId, reservation);
        const original = await this.community.lookupOriginal(
          reservation,
          undefined,
          context.signal,
        );
        this.check(context);
        if (original) {
          const downloaded = await this.media.downloadOriginal(
            original,
            context.signal,
            () => this.check(context),
          );
          try {
            await this.media.validateOriginal(
              downloaded.original,
              context.signal,
              () => this.check(context),
            );
          } catch (error) {
            if (WindowsReuseMedia.shutdownPending(error))
              downloaded.markUnsafe();
            await downloaded.close();
            throw error;
          }
          return this.originalHit(
            downloaded.original,
            {
              kind: "community-youtube",
              videoId,
              provenance: "trusted",
              sourceIdentityVerified: true,
              inputSha256: original.declaration.sha256,
              inputBytes: original.declaration.bytes,
            },
            context,
            downloaded.close,
          );
        }
      }
      return null;
    } catch (error) {
      this.check(context);
      if (optionalUnavailable(error)) return null;
      throw error;
    }
  }
  async completed(
    view: PersonalJobView,
    context: PersonalRunContext,
  ): Promise<void> {
    const reservation = this.reservations.get(context.jobId);
    this.reservations.delete(context.jobId);
    if (
      !this.publisher ||
      view.source?.kind !== "youtube" ||
      context.recipeId !== "kim-vocals-v2"
    )
      return;
    const pair = await this.pairReader.pair(view.id, context.signal);
    if (pair.reuse?.source.kind !== "youtube") return;
    await this.publisher.stage(view.id, true, reservation);
    // Declaration may be sent, but media PUT remains blocked until trusted exact playback acknowledgement.
    void this.publisher.drain().catch(() => {});
  }
  settled(jobId: string): void {
    this.reservations.delete(jobId);
  }
  idle(): boolean {
    return (
      (this.publisher?.activity().idle ?? true) &&
      this.options.cache.cleanupActivity().active === 0
    );
  }
  async dispose(): Promise<void> {
    await this.publisher?.dispose();
    await this.options.cache.close();
  }
  async retainedDirectories(): Promise<Set<string>> {
    return this.publisher?.retainedDirectories() ?? new Set();
  }
}
