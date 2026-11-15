import type {
  PersonalArtifact,
  PersonalJobView,
} from "../../shared/personal-contracts.js";
import {
  PERSONAL_UUID,
  PERSONAL_FORMATS,
} from "../../shared/personal-contracts.js";
import type {
  CompletionReceipt,
  ReuseReceipt,
} from "../../shared/reuse-contracts.js";
import { parseCompletionReceipt, parseReuseReceipt } from "./receipts.js";
import {
  parsePersonalTimeline,
  type PersonalTimeline,
} from "../personal/timeline.js";
import { emptyPartition, parseLibraryPartition } from "../library/store.js";
import {
  personalLibraryEntry,
  type LocalLibraryEntry,
} from "../library/model.js";
export interface VerifiedPersonalPair {
  entry: LocalLibraryEntry;
  view: PersonalJobView;
  filenames: { original: string; vocals: "vocals.mp3" };
  reuse?: ReuseReceipt;
  completion?: CompletionReceipt;
  timeline?: PersonalTimeline;
}
export function parsePersonalPair(
  value: unknown,
  installationId: string,
  jobId: string,
): VerifiedPersonalPair {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PERSONAL_PAIR_INVALID");
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    row.jobId !== jobId ||
    !PERSONAL_UUID.test(jobId) ||
    ["version", "jobId", "original", "vocals"].some(
      (k) => !Object.hasOwn(row, k),
    ) ||
    Object.keys(row).some(
      (k) =>
        ![
          "version",
          "jobId",
          "original",
          "vocals",
          "reuseReceipt",
          "completionReceipt",
          "timeline",
          "source",
        ].includes(k),
    )
  )
    throw new Error("PERSONAL_PAIR_INVALID");
  const a = row.original as PersonalArtifact & { filename: string },
    b = row.vocals as PersonalArtifact & { filename: string };
  if (
    !a ||
    !b ||
    typeof a.filename !== "string" ||
    !/^original\.[a-z0-9]{2,5}$/.test(a.filename) ||
    !PERSONAL_FORMATS.has(a.filename.slice(9)) ||
    b.filename !== "vocals.mp3"
  )
    throw new Error("PERSONAL_PAIR_INVALID");
  const { filename: originalFilename, ...original } = a,
    { filename: _vocalFilename, ...vocals } = b;
  const types: Record<string, string> = {
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    mp3: "audio/mpeg",
    webm: "audio/webm",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    aac: "audio/aac",
    wav: "audio/wav",
    flac: "audio/flac",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
  };
  if (
    original.contentType !== types[originalFilename.slice(9)] ||
    vocals.contentType !== "audio/mpeg"
  )
    throw new Error("PERSONAL_PAIR_INVALID");
  const reuse =
    row.reuseReceipt === undefined
      ? undefined
      : parseReuseReceipt(row.reuseReceipt, {
          originalSha256: original.sha256,
          vocalsSha256: vocals.sha256,
        });
  const completion =
    row.completionReceipt === undefined
      ? undefined
      : parseCompletionReceipt(row.completionReceipt, {
          installationId,
          jobId,
          originalSha256: original.sha256,
          vocalsSha256: vocals.sha256,
        });
  const timeline =
    row.timeline === undefined
      ? undefined
      : parsePersonalTimeline(row.timeline);
  if (reuse && timeline?.trimEnabled) throw new Error("PERSONAL_PAIR_INVALID");
  const videoId =
    reuse?.source.kind !== "file" ? reuse?.source.videoId : undefined;
  const storedSource = row.source as PersonalJobView["source"];
  if (
    row.source !== undefined &&
    (!storedSource ||
      typeof storedSource !== "object" ||
      Array.isArray(storedSource) ||
      (storedSource.kind === "file"
        ? Object.keys(storedSource).join() !== "kind" || videoId !== undefined
        : storedSource.kind !== "youtube" ||
          Object.keys(storedSource).sort().join() !== "kind,videoId" ||
          !/^[A-Za-z0-9_-]{11}$/.test(storedSource.videoId) ||
          (videoId !== undefined && videoId !== storedSource.videoId)))
  )
    throw new Error("PERSONAL_PAIR_INVALID");
  const view: PersonalJobView = {
    id: jobId,
    ownerId: completion?.ownerId ?? jobId,
    state: "ready",
    stage: "output-validation",
    progress: 1,
    error: null,
    name: original.name,
    original,
    vocals,
    source:
      storedSource ??
      (videoId ? { kind: "youtube", videoId } : { kind: "file" }),
  };
  const entry = personalLibraryEntry(
    view,
    completion?.completedAt ?? 0,
    timeline,
  );
  parseLibraryPartition({ ...emptyPartition(null), entries: [entry] }, null);
  if (
    reuse &&
    Math.abs(original.durationSeconds - vocals.durationSeconds) > 0.25
  )
    throw new Error("TIMELINE_INCOMPATIBLE");
  return {
    entry,
    view,
    filenames: { original: originalFilename, vocals: "vocals.mp3" },
    ...(reuse ? { reuse } : {}),
    ...(completion ? { completion } : {}),
    ...(timeline ? { timeline } : {}),
  };
}
