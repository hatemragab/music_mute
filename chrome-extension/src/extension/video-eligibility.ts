import type { ExtensionSettings } from "./settings";
import { MVP_MAX_DURATION_SECONDS } from "../shared/protocol";

interface MediaBoundary {
  video: HTMLVideoElement;
  source: string;
  metadataSerial: number;
}
interface MediaEvidence {
  metadataSerial: number;
  source: string;
}
export interface VideoEligibilitySnapshot {
  video: HTMLVideoElement;
  id: string;
  watchMatches: boolean;
  publicDurationMatches: boolean;
  ad: boolean;
  live: boolean;
}

/** Source strings are compared only in memory; they never enter storage/messages. */
export class VideoEligibility {
  private readonly evidence = new WeakMap<HTMLVideoElement, MediaEvidence>();
  private serial = 0;
  private id: string | null = null;
  private video: HTMLVideoElement | null = null;
  private main: MediaBoundary | null = null;
  private boundary: MediaBoundary | null = null;
  private needsFresh = false;
  private navigating = false;
  private ad = false;
  private adBoundary = false;
  private attempted = false;
  private suppressed = false;

  navigationStart(): void {
    this.navigating = true;
    // Explicit navigation starts a new visit even when the video ID is reused.
    // The media boundary still rejects the previous visit's source/metadata.
    this.attempted = false;
    this.suppressed = false;
    if (!this.needsFresh) this.boundary = this.main;
    this.needsFresh = true;
  }
  navigationFinish(): void {
    this.navigating = false;
  }
  bind(video: HTMLVideoElement | null, id: string | null): void {
    if (video === this.video && id === this.id) return;
    if (!this.needsFresh) this.boundary = this.main;
    if (id !== this.id) {
      this.attempted = false;
      this.suppressed = false;
    }
    this.video = video;
    this.id = id;
    this.main = null;
    this.needsFresh = this.boundary?.video === video;
    if (!this.needsFresh) this.adBoundary = false;
    this.ad = false;
  }
  observe(event: string, video: HTMLVideoElement, ad: boolean): void {
    if (ad) {
      this.boundary = {
        video,
        source: video.currentSrc,
        metadataSerial: this.evidence.get(video)?.metadataSerial ?? 0,
      };
      this.ad = true;
      this.adBoundary = true;
      this.needsFresh = true;
    }
    if (event === "loadstart" || event === "emptied") {
      this.evidence.delete(video);
      return;
    }
    if (
      (event === "loadedmetadata" || event === "durationchange") &&
      !ad &&
      video.readyState >= 1 &&
      Number.isFinite(video.duration) &&
      video.duration > 0
    )
      this.evidence.set(video, {
        metadataSerial: ++this.serial,
        source: video.currentSrc,
      });
  }
  suppress(): void {
    this.suppressed = true;
  }
  markAttempted(): void {
    this.attempted = true;
  }
  ready(snapshot: VideoEligibilitySnapshot): boolean {
    const { video } = snapshot;
    const evidence = this.evidence.get(video);
    const current = {
      video,
      source: video.currentSrc,
      metadataSerial: evidence?.metadataSerial ?? 0,
    };
    if (
      snapshot.ad &&
      (!this.ad || this.boundary?.source !== video.currentSrc)
    ) {
      this.boundary = current;
      this.needsFresh = true;
      this.adBoundary = true;
    }
    this.ad = snapshot.ad;
    if (
      this.navigating ||
      video !== this.video ||
      snapshot.id !== this.id ||
      !snapshot.watchMatches ||
      snapshot.ad ||
      snapshot.live ||
      video.readyState < 1 ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0
    )
      return false;
    if (this.needsFresh && this.boundary?.video === video) {
      const metadataChanged =
        evidence !== undefined &&
        evidence.metadataSerial > this.boundary.metadataSerial &&
        evidence.source === video.currentSrc;
      const sourceChanged =
        !!video.currentSrc &&
        video.currentSrc !== this.boundary.source &&
        snapshot.publicDurationMatches;
      if (!metadataChanged && !sourceChanged) return false;
      if (this.adBoundary && video.currentSrc === this.boundary.source)
        return false;
    }
    const fresh = this.needsFresh;
    this.needsFresh = false;
    this.adBoundary = false;
    // Keep the visit baseline when next-video media arrives before its route ID.
    if (!this.main || fresh) this.main = current;
    return true;
  }
  eligible(
    snapshot: VideoEligibilitySnapshot,
    settings: ExtensionSettings,
  ): boolean {
    const { video } = snapshot;
    return (
      this.ready(snapshot) &&
      settings.autoStartEnabled &&
      !this.attempted &&
      !this.suppressed &&
      !video.paused &&
      !video.ended &&
      !video.seeking &&
      video.duration < settings.maxDurationMinutes * 60 &&
      video.duration <= MVP_MAX_DURATION_SECONDS
    );
  }
}
