import { randomUUID } from "node:crypto";
import type { SessionAccountScope } from "../src/shared/session-contracts.js";
import type { PersonalJobView } from "../src/shared/personal-contracts.js";
import {
  emptyPartition,
  type LibraryDiskPort,
  type LibraryPartition,
} from "../src/main/library/store.js";
export const libraryOwnerA: SessionAccountScope = {
    firebaseUid: "library-owner-a",
    generation: randomUUID(),
  },
  libraryOwnerB: SessionAccountScope = {
    firebaseUid: "library-owner-b",
    generation: randomUUID(),
  };
export function libraryPersonal(
  name = "Local voice",
  id = randomUUID(),
): PersonalJobView {
  return {
    id,
    ownerId: randomUUID(),
    state: "ready",
    stage: "encoding",
    progress: 1,
    name,
    source: { kind: "youtube", videoId: "12345678901" },
    error: null,
    original: {
      id: randomUUID(),
      kind: "original",
      name: "original.m4a",
      bytes: 3,
      sha256: "a".repeat(64),
      durationSeconds: 60,
      contentType: "audio/mp4",
    },
    vocals: {
      id: randomUUID(),
      kind: "vocals",
      name: "vocals.mp3",
      bytes: 3,
      sha256: "b".repeat(64),
      durationSeconds: 60,
      contentType: "audio/mpeg",
    },
  };
}
export function libraryJob(
  id = "0123456789abcdef01234567",
  title = "Cloud voice",
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    request_id: randomUUID(),
    status: "ready",
    processing_origin: "cloud",
    source_kind: "file",
    source_title: title,
    display_name: null,
    trim_enabled: false,
    input: {
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: 3,
      duration_seconds: 60,
      sha256: Buffer.alloc(32, 0xaa).toString("base64"),
    },
    output: {
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: 3,
      duration_seconds: 60,
      sha256: Buffer.alloc(32, 0xbb).toString("base64"),
    },
    can_download_input: true,
    can_download_output: true,
    updated_at: "2026-10-09T00:00:00Z",
    ...extra,
  };
}
export class MemoryLibraryDisk implements LibraryDiskPort {
  readonly partitions = new Map<string | null, LibraryPartition>();
  afterWrite: (() => void) | undefined;
  private serial: Promise<void> = Promise.resolve();
  async read(uid: string | null) {
    return structuredClone(this.partitions.get(uid) ?? emptyPartition(uid));
  }
  async write(partition: LibraryPartition) {
    this.partitions.set(partition.ownerUid, structuredClone(partition));
    this.afterWrite?.();
  }
  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
