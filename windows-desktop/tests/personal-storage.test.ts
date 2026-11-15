import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((part) => part.replaceAll("\\", "/"))),
    },
  };
});
import { storageFixture } from "./storage-fixtures.js";
import { PrivatePersonalStorage } from "../src/main/personal/storage.js";
import { PERSONAL_RECIPE_DIGESTS } from "../src/main/personal/timeline.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  trim = true,
  inputBytes = Buffer.from("readonly-input-code-fixture"),
) {
  const f = await storageFixture();
  roots.push(f.root);
  const jobId = randomUUID(),
    inputRoot = await f.host.directory(`personal\\jobs\\${jobId}\\input`),
    outputRoot = await f.host.directory(
      `personal\\jobs\\${jobId}\\engine\\${jobId}\\output`,
    ),
    outputBytes = Buffer.from("synthetic-output-code-fixture"),
    inputPath = join(inputRoot, "source.wav"),
    outputPath = join(outputRoot, "vocals.mp3");
  await writeFile(inputPath, inputBytes);
  await writeFile(outputPath, outputBytes);
  const sha = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex"),
    input = {
      path: inputPath,
      name: "source.wav",
      bytes: inputBytes.length,
      sha256: sha(inputBytes),
    },
    recipeId = trim ? "kim-vocals-v2-trim" : "kim-vocals-v2";
  const raw = {
    attemptId: jobId,
    outputPath,
    contentType: "audio/mpeg",
    modelDigest: MODEL.sha256,
    trimEnabled: trim,
    denoiseEnabled: false,
    outputFormat: "mp3",
    outputBitrateKbps: 160,
    sampleRate: 44100,
    channels: 2,
    bytes: outputBytes.length,
    sha256: Buffer.from(sha(outputBytes), "hex").toString("base64"),
    sourceDurationSeconds: 60,
    measuredOutputDurationSeconds: trim ? 59.03 : 60.03,
    sourceSamples: 2646000,
    outputSamples: trim ? 2601900 : 2646000,
    removedSamples: trim ? 44100 : 0,
    recipeId,
    recipeRevision: 6,
    recipeDigest: PERSONAL_RECIPE_DIGESTS[recipeId],
    editMap: {
      version: 1,
      rangeCount: trim ? 2 : 1,
      chunks: [
        trim
          ? [
              {
                sourceStart: 0,
                sourceEnd: 44100,
                outputStart: 0,
                outputEnd: 44100,
              },
              {
                sourceStart: 88200,
                sourceEnd: 2646000,
                outputStart: 44100,
                outputEnd: 2601900,
              },
            ]
          : [
              {
                sourceStart: 0,
                sourceEnd: 2646000,
                outputStart: 0,
                outputEnd: 2646000,
              },
            ],
      ],
    },
  };
  const storage = new PrivatePersonalStorage(f.host, {
    assertRecoveredExit: (relative) =>
      f.controller.assertWorkspaceExited(relative),
    beginWrite: (relative, kind) => f.controller.beginWrite(relative, kind),
    trackWorkspace: (relative) =>
      f.controller.trackWorkspace(
        relative,
        { role: "personal", nonce: "a".repeat(64), identity: f.parent },
        "processing",
      ),
    protectTree: (relative, purpose) =>
      f.controller.protectTree(relative, purpose),
    protectPlannedTree: (relative, purpose) =>
      f.controller.protectTree(relative, purpose, true),
    reserveVoice: (bytes, relative) =>
      f.controller.reserveVoice(bytes, relative),
  });
  return { ...f, jobId, input, inputBytes, outputBytes, raw, storage };
}
describe("private personal result publication (synthetic bytecode fixtures)", () => {
  it("a trimmed YouTube completion keeps its actual source metadata during pair recovery without claiming full-timeline reuse", async () => {
    const f = await fixture(true),
      ownerId = randomUUID(),
      requestId = randomUUID(),
      videoId = "bZxrIoCPsOc",
      input = {
        ...f.input,
        sourceIdentity: {
          kind: "youtube" as const,
          videoId,
          formatId: "140",
          audioTrackId: null,
          audioIsDefault: true,
          language: "en",
          inputSha256: f.input.sha256,
          inputBytes: f.input.bytes,
        },
      };
    await f.storage.workDirectory(f.jobId);
    await f.storage.commit(
      f.jobId,
      input,
      {
        ...f.raw,
        completionContext: {
          ownerId,
          requestId,
          capturedAccountScope: null,
          submittedSource: { kind: "youtube", videoId },
        },
      },
      new AbortController().signal,
    );
    await f.storage.cleanup(f.jobId, true);
    const recovered = await f.storage.recover({
        ownerId,
        requestId,
        jobId: f.jobId,
        digest: "a".repeat(64),
        state: "inflight",
        capturedAccountScope: null,
      }),
      pair = JSON.parse(
        await readFile(
          join(f.root, "personal", "results", f.jobId, "pair.json"),
          "utf8",
        ),
      );
    expect(recovered?.view.source).toEqual({ kind: "youtube", videoId });
    expect(recovered?.result.timeline?.trimEnabled).toBe(true);
    expect(pair.reuseReceipt).toBeUndefined();
    await f.controller.scan(new AbortController().signal);
    expect(f.controller.view().errorCode).toBeNull();
  });
  it("preserves trusted original-only community source and captured null completion through new inference and restart recovery", async () => {
    const f = await fixture(false),
      ownerId = randomUUID(),
      requestId = randomUUID(),
      videoId = "bZxrIoCPsOc",
      input = {
        ...f.input,
        sourceIdentity: {
          kind: "community-youtube" as const,
          videoId,
          provenance: "trusted" as const,
          sourceIdentityVerified: true,
          inputSha256: f.input.sha256,
          inputBytes: f.input.bytes,
        },
      };
    await f.storage.workDirectory(f.jobId);
    const result = await f.storage.commit(
      f.jobId,
      input,
      {
        ...f.raw,
        completionContext: {
          ownerId,
          requestId,
          capturedAccountScope: null,
          submittedSource: { kind: "youtube", videoId },
        },
      },
      new AbortController().signal,
    );
    const pair = JSON.parse(
      await readFile(
        join(f.root, "personal", "results", f.jobId, "pair.json"),
        "utf8",
      ),
    );
    expect(pair.reuseReceipt.source).toEqual(input.sourceIdentity);
    expect(pair.source).toEqual({ kind: "youtube", videoId });
    expect(pair.completionReceipt.capturedAccountScope).toBeNull();
    await f.storage.cleanup(f.jobId, true);
    const recovered = await f.storage.recover({
      ownerId,
      requestId,
      jobId: f.jobId,
      digest: "a".repeat(64),
      state: "inflight",
      capturedAccountScope: null,
    });
    expect(recovered).toMatchObject({
      view: { ownerId, state: "ready", source: { kind: "youtube", videoId } },
      result,
    });
    await expect(
      f.storage.recover({
        ownerId,
        requestId: randomUUID(),
        jobId: f.jobId,
        digest: "a".repeat(64),
        state: "inflight",
        capturedAccountScope: null,
      }),
    ).rejects.toThrow("OUTPUT_INVALID");
  });
  it("recovery will not clean old scratch until its actual native whole-tree exit proof is positive", async () => {
    const f = await fixture(false);
    await f.storage.workDirectory(f.jobId);
    const restarted = new PrivatePersonalStorage(f.host, {
      assertRecoveredExit: (relative) =>
        f.controller.assertWorkspaceExited(relative),
      beginWrite: (relative, kind) => f.controller.beginWrite(relative, kind),
      trackWorkspace: (relative) =>
        f.controller.trackWorkspace(
          relative,
          { role: "personal", nonce: "a".repeat(64), identity: f.parent },
          "processing",
        ),
      protectTree: (relative, purpose) =>
        f.controller.protectTree(relative, purpose),
      protectPlannedTree: (relative, purpose) =>
        f.controller.protectTree(relative, purpose, true),
      reserveVoice: (bytes, relative) =>
        f.controller.reserveVoice(bytes, relative),
    });
    f.setAlive(false);
    await expect(restarted.cleanup(f.jobId, true)).rejects.toThrow(
      "STOP_UNCONFIRMED",
    );
    expect(await readFile(f.input.path)).toEqual(f.inputBytes);
    f.setExited(true);
    await restarted.cleanup(f.jobId, true);
    await expect(readFile(f.input.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("commitsrealtrimmetadata/exactsamplemap with both immutable artifacts", async () => {
    const f = await fixture(),
      result = await f.storage.commit(
        f.jobId,
        f.input,
        f.raw,
        new AbortController().signal,
      );
    expect(result.timeline).toEqual({
      version: 1,
      trimEnabled: true,
      sourceSamples: 2646000,
      outputSamples: 2601900,
      comparisonRanges: [
        [0, 44100],
        [88200, 2646000],
      ],
    });
    const root = join(f.root, "personal", "results", f.jobId),
      pair = JSON.parse(await readFile(join(root, "pair.json"), "utf8"));
    expect(pair.timeline).toEqual(result.timeline);
    expect(pair.reuseReceipt).toBeUndefined();
    expect(await readFile(join(root, "original.wav"))).toEqual(f.inputBytes);
    expect(await readFile(join(root, "vocals.mp3"))).toEqual(f.outputBytes);
    expect(await readFile(f.input.path)).toEqual(f.inputBytes);
    expect(await f.pins.hasLiveConsumers()).toBe(true);
    await f.storage.cleanup(f.jobId, true);
    expect(await f.pins.hasLiveConsumers()).toBe(false);
    expect(await readFile(join(root, "vocals.mp3"))).toEqual(f.outputBytes);
  });
  it("retainsfulltimelinebehavior when trimdisabled", async () => {
    const f = await fixture(false),
      result = await f.storage.commit(
        f.jobId,
        f.input,
        f.raw,
        new AbortController().signal,
      );
    expect(result.timeline).toMatchObject({
      trimEnabled: false,
      sourceSamples: 2646000,
      outputSamples: 2646000,
      comparisonRanges: [[0, 2646000]],
    });
    await f.storage.cleanup(f.jobId, true);
  });
  it("copies a source spanning multiple bounded native reads and preserves every byte through publication", async () => {
    const f = await fixture(false, Buffer.alloc(2 * 1024 ** 2 + 19, 0x73));
    await f.storage.commit(
      f.jobId,
      f.input,
      f.raw,
      new AbortController().signal,
    );
    expect(
      await readFile(
        join(f.root, "personal", "results", f.jobId, "original.wav"),
      ),
    ).toEqual(f.inputBytes);
    expect(await readFile(f.input.path)).toEqual(f.inputBytes);
  });
  it("a denied retained source reader stops result copying and preserves the original without publishing a pair", async () => {
    const f = await fixture(false),
      actualOpen = f.native.openPrivateFile.getMockImplementation()!,
      source = `personal\\jobs\\${f.jobId}\\input\\source.wav`;
    f.native.openPrivateFile.mockImplementation(async (...args) => {
      if (args[0] === source && args[2] === f.input.bytes)
        throw new Error("PATH_UNSAFE");
      return actualOpen(...args);
    });
    await expect(
      f.storage.commit(f.jobId, f.input, f.raw, new AbortController().signal),
    ).rejects.toThrow("PATH_UNSAFE");
    expect(await readFile(f.input.path)).toEqual(f.inputBytes);
    await expect(
      readFile(join(f.root, "personal", "results", f.jobId, "pair.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        join(
          f.root,
          "personal",
          "results",
          `${f.jobId}.pending`,
          "original.wav",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("a retained source change closes the reader and prevents personal pair publication", async () => {
    const f = await fixture(false),
      actualOpen = f.native.openPrivateFile.getMockImplementation()!,
      source = `personal\\jobs\\${f.jobId}\\input\\source.wav`;
    let closed = false;
    f.native.openPrivateFile.mockImplementation(async (...args) => {
      const file = await actualOpen(...args);
      if (args[0] !== source || args[2] !== f.input.bytes) return file;
      let observations = 0;
      return {
        ...file,
        info: async () => {
          const identity = await file.info();
          if (++observations === 2)
            return {
              ...identity,
              changedAt: String(BigInt(identity.changedAt) + 1n),
            };
          return identity;
        },
        close: async () => {
          await file.close();
          closed = true;
        },
      };
    });
    await expect(
      f.storage.commit(f.jobId, f.input, f.raw, new AbortController().signal),
    ).rejects.toThrow("OUTPUT_INVALID");
    expect(closed).toBe(true);
    expect(await readFile(f.input.path)).toEqual(f.inputBytes);
    await expect(
      readFile(join(f.root, "personal", "results", f.jobId, "pair.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refusesdishonesttrimmap/recipe beforepublishing andpreserves input", async () => {
    const f = await fixture();
    f.raw.editMap.chunks[0]![1]!.outputStart = 0;
    await expect(
      f.storage.commit(f.jobId, f.input, f.raw, new AbortController().signal),
    ).rejects.toThrow("OUTPUT_INVALID");
    expect(await readFile(f.input.path)).toEqual(f.inputBytes);
    await expect(
      readFile(join(f.root, "personal", "results", f.jobId, "pair.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
