import { createHash } from "node:crypto";
import { sanitizeSourceTitle } from "../../../../chrome-extension/src/shared/protocol.js";
import { publicThumbnailUrl } from "../../../../chrome-extension/src/shared/thumbnail-url.js";
import {
  parseJobMetadata,
  type JobMetadata,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import type { DesktopCatalogItem } from "../../../../chrome-extension/src/companion/desktop-catalog.js";
import { PlaybackTimeline, type ComparisonRange } from "../player/timeline.js";
import {
  parsePersonalTimeline,
  type PersonalTimeline,
} from "../personal/timeline.js";
import type {
  PersonalArtifact,
  PersonalJobView,
} from "../../shared/personal-contracts.js";
import type {
  LibraryTrackView,
  LibraryQuery,
} from "../../shared/library-contracts.js";
export interface LocalLibraryEntry {
  catalog: Omit<DesktopCatalogItem, "vocal_path">;
  personalJobId: string;
  original: PersonalArtifact;
  vocals: PersonalArtifact;
  timeline?: PersonalTimeline;
}
export interface AccountLibraryJob {
  metadata: JobMetadata;
  updatedAt: number | null;
  comparisonRanges: ComparisonRange[] | undefined;
}
export interface AccountLibraryLink {
  localId: string;
  jobId: string;
  outputSha256: string;
}
export interface LibraryPreferences {
  starred: string[];
  hidden: string[];
  counts: Record<string, number>;
}
export const EMPTY_LIBRARY_PREFERENCES = (): LibraryPreferences => ({
  starred: [],
  hidden: [],
  counts: {},
});
export function localTrackId(entry: LocalLibraryEntry): string {
  return `local:${entry.catalog.cache_key}`;
}
export function personalLibraryEntry(
  view: PersonalJobView,
  now: number,
  privateTimeline?: PersonalTimeline,
): LocalLibraryEntry {
  if (
    view.state !== "ready" ||
    !view.original ||
    !view.vocals ||
    view.original.kind !== "original" ||
    view.vocals.kind !== "vocals"
  )
    throw new Error("LIBRARY_RESULT_INVALID");
  const video =
    view.source?.kind === "youtube" ? view.source.videoId : undefined;
  const timeline =
    privateTimeline === undefined
      ? undefined
      : parsePersonalTimeline(privateTimeline);
  if (
    timeline &&
    (Math.abs(view.original.durationSeconds - timeline.sourceSamples / 44100) >
      0.25 ||
      Math.abs(view.vocals.durationSeconds - timeline.outputSamples / 44100) >
        0.25)
  )
    throw new Error("LIBRARY_TIMELINE_INVALID");
  if (
    !timeline &&
    Math.abs(view.original.durationSeconds - view.vocals.durationSeconds) > 0.25
  )
    throw new Error("LIBRARY_TIMELINE_UNAVAILABLE");
  const cache_key = createHash("sha256")
    .update(`windows-personal-v1:${view.id}:${view.vocals.sha256}`)
    .digest("hex");
  return {
    catalog: {
      cache_key,
      operation_id: view.id,
      source_kind: video ? "url" : "file",
      source_title: sanitizeSourceTitle(view.name) ?? "Voice track",
      duration_seconds: view.vocals.durationSeconds,
      source_duration_seconds: timeline
        ? timeline.sourceSamples / 44100
        : view.original.durationSeconds,
      trim_enabled: timeline?.trimEnabled ?? false,
      bytes: view.vocals.bytes,
      sha256: view.vocals.sha256,
      ...(video
        ? {
            video_id: video,
            thumbnail_url: `https://i.ytimg.com/vi/${video}/hqdefault.jpg`,
          }
        : {}),
      created_at: now,
      updated_at: now,
    },
    personalJobId: view.id,
    original: structuredClone(view.original),
    vocals: structuredClone(view.vocals),
    ...(timeline ? { timeline } : {}),
  };
}
export function accountLibraryJob(value: unknown): AccountLibraryJob {
  const metadata = parseJobMetadata(value);
  const row = value as Record<string, unknown>;
  const dates = [row.updated_at, row.created_at]
    .map((value) => (typeof value === "string" ? Date.parse(value) : NaN))
    .filter(Number.isFinite);
  let comparisonRanges: ComparisonRange[] | undefined;
  if (
    metadata.trim_enabled &&
    row.comparison_ranges !== undefined &&
    row.comparison_ranges !== null
  ) {
    try {
      if (!Array.isArray(row.comparison_ranges))
        throw new Error("COMPARISON_TIMELINE_UNAVAILABLE");
      comparisonRanges = row.comparison_ranges as ComparisonRange[];
      const timeline = new PlaybackTimeline(
        metadata.input.duration_seconds,
        true,
        comparisonRanges,
      );
      if (
        metadata.output?.duration_seconds != null &&
        Math.abs(timeline.outputDuration - metadata.output.duration_seconds) >
          0.25
      )
        throw new Error("COMPARISON_TIMELINE_UNAVAILABLE");
      comparisonRanges = structuredClone(comparisonRanges);
    } catch {
      comparisonRanges = undefined;
    }
  }
  return {
    metadata,
    updatedAt: dates.length ? Math.max(...dates) : null,
    comparisonRanges,
  };
}
function aliases(track: LibraryTrackView): string[] {
  return [track.id, ...(track.jobId ? [track.jobId] : [])];
}
export function mergeLibrary(
  local: readonly LocalLibraryEntry[],
  jobs: readonly AccountLibraryJob[],
  links: readonly AccountLibraryLink[],
  preferences: LibraryPreferences,
  offlineAccountIds: ReadonlySet<string> = new Set(),
): LibraryTrackView[] {
  const cloud = new Map(
    jobs
      .filter((job) => job.metadata.status === "ready")
      .map((job) => [job.metadata.id, job]),
  );
  const linked = new Set<string>();
  const tracks: LibraryTrackView[] = local.map((entry) => {
    const id = localTrackId(entry),
      link = links.find(
        (link) =>
          link.localId === id && link.outputSha256 === entry.vocals.sha256,
      ),
      candidate = link ? cloud.get(link.jobId) : undefined,
      matches =
        !candidate ||
        (candidate.metadata.output &&
          Buffer.from(candidate.metadata.output.sha256, "base64").toString(
            "hex",
          ) === entry.vocals.sha256),
      job = matches ? candidate : undefined;
    if (link && matches) linked.add(link.jobId);
    const title =
      sanitizeSourceTitle(job?.metadata.display_name) ??
      sanitizeSourceTitle(job?.metadata.source_title) ??
      entry.catalog.source_title ??
      "Voice track";
    return {
      id,
      jobId: matches ? (link?.jobId ?? null) : null,
      title,
      sourceKind: entry.catalog.source_kind,
      videoId: entry.catalog.video_id ?? null,
      durationSeconds: entry.vocals.durationSeconds,
      sourceDurationSeconds:
        entry.catalog.source_duration_seconds ?? entry.original.durationSeconds,
      trimEnabled: entry.timeline?.trimEnabled ?? false,
      offline: true,
      online: job?.metadata.can_download_output ?? false,
      originalAvailable: true,
      accountOwned: false,
      thumbnailUrl: publicThumbnailUrl(
        job?.metadata.thumbnail_url ?? entry.catalog.thumbnail_url,
      ),
      starred: false,
      removed: false,
      playCount: 0,
      updatedAt: Math.max(entry.catalog.updated_at, job?.updatedAt ?? 0),
      canRename: !!job,
      canDeleteAccount: !!job,
      canExport: true,
    };
  });
  for (const [id, job] of cloud) {
    if (linked.has(id) || !job.metadata.output) continue;
    const offline = offlineAccountIds.has(id);
    tracks.push({
      id,
      jobId: id,
      title:
        sanitizeSourceTitle(job.metadata.display_name) ??
        sanitizeSourceTitle(job.metadata.source_title) ??
        "Voice track",
      sourceKind: job.metadata.source_kind ?? "file",
      videoId: null,
      durationSeconds:
        job.metadata.output.duration_seconds ??
        job.metadata.input.duration_seconds,
      sourceDurationSeconds: job.metadata.input.duration_seconds,
      trimEnabled: job.metadata.trim_enabled,
      offline,
      online: job.metadata.can_download_output,
      originalAvailable: job.metadata.can_download_input,
      accountOwned: true,
      thumbnailUrl: publicThumbnailUrl(job.metadata.thumbnail_url),
      starred: false,
      removed: false,
      playCount: 0,
      updatedAt: job.updatedAt,
      canRename: true,
      canDeleteAccount: true,
      canExport: offline,
    });
  }
  return tracks.map((track) => {
    const keys = aliases(track);
    return {
      ...track,
      starred: keys.some((key) => preferences.starred.includes(key)),
      removed: keys.some((key) => preferences.hidden.includes(key)),
      playCount: Math.max(
        0,
        ...keys.map((key) => preferences.counts[key] ?? 0),
      ),
    };
  });
}
export function visibleLibrary(
  tracks: readonly LibraryTrackView[],
  query: LibraryQuery,
  locale = "en",
): LibraryTrackView[] {
  const collator = new Intl.Collator(locale, {
      sensitivity: "base",
      numeric: true,
    }),
    search = query.search.normalize("NFKC").toLocaleLowerCase(locale);
  const filtered = tracks.filter(
    (track) =>
      (!search ||
        track.title
          .normalize("NFKC")
          .toLocaleLowerCase(locale)
          .includes(search)) &&
      (query.filter === "removed" ? track.removed : !track.removed) &&
      (!(query.starredOnly || query.filter === "starred") || track.starred) &&
      (query.filter !== "offline" || track.offline) &&
      (query.filter !== "online" || !track.offline) &&
      (!query.mostPlayedOnly || track.playCount > 0),
  );
  return filtered.sort((a, b) => {
    const title = () =>
      collator.compare(a.title, b.title) || a.id.localeCompare(b.id);
    if (query.mostPlayedOnly || query.sort === "most-played")
      return b.playCount - a.playCount || title();
    if (query.sort === "title") return title();
    return (b.updatedAt ?? -1) - (a.updatedAt ?? -1) || title();
  });
}
