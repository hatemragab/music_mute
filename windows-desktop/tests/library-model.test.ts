import { describe, expect, it } from "vitest";
import {
  accountLibraryJob,
  EMPTY_LIBRARY_PREFERENCES,
  localTrackId,
  mergeLibrary,
  personalLibraryEntry,
  visibleLibrary,
} from "../src/main/library/model.js";
import {
  DEFAULT_LIBRARY_QUERY,
  parseLibraryAction,
} from "../src/shared/library-contracts.js";
import {
  emptyPartition,
  parseLibraryPartition,
} from "../src/main/library/store.js";
import { libraryJob, libraryPersonal } from "./library-fixtures.js";
describe("Library stable identity and visible order", () => {
  it("merges only an explicit current-account link and retains signed-out personal files", () => {
    const local = personalLibraryEntry(libraryPersonal(), 1),
      job = accountLibraryJob(libraryJob()),
      p = EMPTY_LIBRARY_PREFERENCES();
    expect(mergeLibrary([local], [job], [], p)).toHaveLength(2);
    const links = [
      {
        localId: localTrackId(local),
        jobId: job.metadata.id,
        outputSha256: local.vocals.sha256,
      },
    ];
    expect(mergeLibrary([local], [job], links, p)).toMatchObject([
      {
        id: localTrackId(local),
        jobId: job.metadata.id,
        offline: true,
        accountOwned: false,
        canRename: true,
      },
    ]);
    expect(mergeLibrary([local], [], [], p)).toMatchObject([
      { jobId: null, offline: true, canRename: false },
    ]);
  });
  it("shares star/hide/history aliases without summing duplicate counts", () => {
    const local = personalLibraryEntry(libraryPersonal(), 1),
      job = accountLibraryJob(libraryJob()),
      id = localTrackId(local);
    const tracks = mergeLibrary(
      [local],
      [job],
      [
        {
          localId: id,
          jobId: job.metadata.id,
          outputSha256: local.vocals.sha256,
        },
      ],
      {
        starred: [job.metadata.id],
        hidden: [id],
        counts: { [id]: 2, [job.metadata.id]: 5 },
      },
    );
    expect(tracks[0]).toMatchObject({
      starred: true,
      removed: true,
      playCount: 5,
    });
    expect(visibleLibrary(tracks, DEFAULT_LIBRARY_QUERY)).toEqual([]);
    expect(
      visibleLibrary(tracks, { ...DEFAULT_LIBRARY_QUERY, filter: "removed" }),
    ).toHaveLength(1);
  });
  it("uses exact visible filtered/sorted order and deterministic title ties", () => {
    const a = personalLibraryEntry(libraryPersonal("Track 10"), 2),
      b = personalLibraryEntry(libraryPersonal("Track 2"), 1),
      cloud = accountLibraryJob(libraryJob(undefined, "Arabic أغنية"));
    const tracks = mergeLibrary([a, b], [cloud], [], {
      starred: [localTrackId(a)],
      hidden: [],
      counts: { [localTrackId(a)]: 4, [localTrackId(b)]: 2 },
    });
    expect(
      visibleLibrary(tracks, {
        ...DEFAULT_LIBRARY_QUERY,
        sort: "title",
        filter: "offline",
      }).map((t) => t.title),
    ).toEqual(["Track 2", "Track 10"]);
    expect(
      visibleLibrary(tracks, {
        ...DEFAULT_LIBRARY_QUERY,
        mostPlayedOnly: true,
      }).map((t) => t.title),
    ).toEqual(["Track 10", "Track 2"]);
    expect(
      visibleLibrary(tracks, {
        ...DEFAULT_LIBRARY_QUERY,
        filter: "online",
      }).map((t) => t.id),
    ).toEqual([cloud.metadata.id]);
    expect(
      visibleLibrary(tracks, { ...DEFAULT_LIBRARY_QUERY, search: "أغنية" }),
    ).toHaveLength(1);
  });
  it("keeps valid trimmed voice metadata while missing or dishonest comparison maps stay unavailable", () => {
    expect(
      accountLibraryJob(
        libraryJob(undefined, undefined, { trim_enabled: true }),
      ).comparisonRanges,
    ).toBeUndefined();
    expect(
      accountLibraryJob(
        libraryJob(undefined, undefined, {
          trim_enabled: true,
          comparison_ranges: [[0, 44100]],
        }),
      ).comparisonRanges,
    ).toBeUndefined();
    const row = libraryJob(undefined, undefined, {
      trim_enabled: true,
      comparison_ranges: [[0, 30 * 44100]],
      output: { ...libraryJob().output, duration_seconds: 30 },
    });
    expect(accountLibraryJob(row).comparisonRanges).toEqual([[0, 1323000]]);
  });
  it("rejects private thumbnails, corrupt owner partitions and ambiguous deletion commands", () => {
    const p = emptyPartition(null);
    p.entries = [personalLibraryEntry(libraryPersonal(), 1)];
    expect(parseLibraryPartition(p, null).entries).toHaveLength(1);
    expect(() => parseLibraryPartition(p, "other")).toThrow("LIBRARY_CORRUPT");
    p.entries[0]!.catalog.thumbnail_url =
      "https://private.r2.cloudflarestorage.com/image";
    expect(() => parseLibraryPartition(p, null)).toThrow("LIBRARY_CORRUPT");
    expect(() =>
      parseLibraryAction({
        type: "DELETE_ACCOUNT",
        trackId: "0123456789abcdef01234567",
      }),
    ).toThrow("INVALID_REQUEST");
    expect(
      parseLibraryAction({
        type: "DELETE_ACCOUNT",
        trackId: "0123456789abcdef01234567",
        confirmation: "delete-account-item",
      }),
    ).toMatchObject({ type: "DELETE_ACCOUNT" });
  });
});
