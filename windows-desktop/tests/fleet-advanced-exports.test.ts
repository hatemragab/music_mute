import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { FileCapabilities } from "../src/main/file-capabilities.js";
import {
  readAdvancedBaseline,
  openAdvancedExport,
} from "../src/main/fleet/advanced/benchmark-exports.js";
import { parseFleetAdvancedMutation } from "../src/shared/fleet-advanced-contracts.js";
import {
  consumerRepeatedStored,
  processIdentity,
} from "./fleet-advanced-fixtures.js";
import type { HostContext } from "../src/main/host-context.js";
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.flatMap((part) => part.split("\\"))),
    },
  };
});
it("read-only baseline capability is consumed once and original report bytes stay unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-baseline-"));
  try {
    const path = join(root, "baseline.json"),
      bytes = Buffer.from(JSON.stringify(consumerRepeatedStored())),
      files = new FileCapabilities();
    await writeFile(path, bytes);
    const selected = await files.grant(path, "window");
    const report = await readAdvancedBaseline(
      files,
      selected.capability,
      "window",
      processIdentity.sid,
      new AbortController().signal,
    );
    expect(report.provider).toBe("directml");
    expect(await readFile(path)).toEqual(bytes);
    await expect(
      readAdvancedBaseline(
        files,
        selected.capability,
        "window",
        processIdentity.sid,
        new AbortController().signal,
      ),
    ).rejects.toThrow("INPUT_CAPABILITY_EXPIRED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("changed source, foreign SID and oversized report never become a baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-baseline-"));
  try {
    const path = join(root, "baseline.json"),
      files = new FileCapabilities();
    await writeFile(path, JSON.stringify(consumerRepeatedStored()));
    let cap = await files.grant(path, "window");
    await writeFile(path, "{}");
    await expect(
      readAdvancedBaseline(
        files,
        cap.capability,
        "window",
        processIdentity.sid,
        new AbortController().signal,
      ),
    ).rejects.toThrow("INPUT_CHANGED");
    await writeFile(path, JSON.stringify(consumerRepeatedStored()));
    cap = await files.grant(path, "window");
    await expect(
      readAdvancedBaseline(
        files,
        cap.capability,
        "window",
        "S-1-5-21-9-8-7-1001",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await writeFile(path, Buffer.alloc(2 * 1024 ** 2 + 1));
    cap = await files.grant(path, "window");
    await expect(
      readAdvancedBaseline(
        files,
        cap.capability,
        "window",
        processIdentity.sid,
        new AbortController().signal,
      ),
    ).rejects.toThrow("ADVANCED_BASELINE_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("saved audio export lends a verified readonly descriptor with fixed filename and rejects checksum/link substitution", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-benchmark-export-"));
  try {
    const relative = "prepare\\work\\fixture\\saved-audio\\01-cold-vocals.mp3",
      path = join(root, ...relative.split("\\")),
      bytes = Buffer.from("synthetic audio fixture"),
      expected = {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    await mkdir(join(root, "prepare", "work", "fixture", "saved-audio"), {
      recursive: true,
    });
    await writeFile(path, bytes);
    const host = {
      personalRoot: root,
      native: {
        validatePath: async (_ns: string, r: string) => {
          const s = await lstat(join(root, ...r.split("\\")));
          if (s.isSymbolicLink() || !s.isFile() || s.nlink !== 1)
            throw new Error("ACL_UNSAFE");
        },
      },
    } as unknown as HostContext;
    const entry = await openAdvancedExport(
      host,
      relative,
      "01-cold-vocals.mp3",
      expected,
      new AbortController().signal,
    );
    const actual = Buffer.alloc(bytes.length);
    await entry.file.read(actual, 0, actual.length, 0);
    expect(actual).toEqual(bytes);
    await expect(entry.file.writeFile("replacement")).rejects.toMatchObject({
      code: "EBADF",
    });
    await entry.file.close();
    await writeFile(path, Buffer.alloc(bytes.length));
    await expect(
      openAdvancedExport(
        host,
        relative,
        "01-cold-vocals.mp3",
        expected,
        new AbortController().signal,
      ),
    ).rejects.toThrow("ADVANCED_EXPORT_INVALID");
    await rm(path);
    const other = join(root, "other.mp3");
    await writeFile(other, bytes);
    await symlink(other, path);
    await expect(
      openAdvancedExport(
        host,
        relative,
        "01-cold-vocals.mp3",
        expected,
        new AbortController().signal,
      ),
    ).rejects.toThrow("ACL_UNSAFE");
    expect(await readFile(other)).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("benchmark parameter extension keeps simple defaults but never accepts arbitrary candidate path or unsupported DirectML batch", () => {
  const base = {
    action: "benchmark_file",
    inputCapability: "10000000-0000-4000-8000-000000000001",
    recipe: "kim-vocals-v2",
    warmupRuns: 1,
    measuredRuns: 3,
    rightsConfirmed: true,
  };
  expect(parseFleetAdvancedMutation(base)).toEqual(base);
  expect(
    parseFleetAdvancedMutation({
      ...base,
      groupSize: 1,
      candidateRelease: "a".repeat(64),
      saveAudio: true,
      audioDestinationCapability: "10000000-0000-4000-8000-000000000002",
    }),
  ).toMatchObject({ groupSize: 1 });
  for (const value of [
    { ...base, groupSize: 2 },
    { ...base, candidateRelease: "C:\\untrusted" },
    { ...base, saveAudio: true },
    {
      ...base,
      saveAudio: false,
      audioDestinationCapability: "10000000-0000-4000-8000-000000000002",
    },
  ])
    expect(() => parseFleetAdvancedMutation(value)).toThrow(
      "ADVANCED_REQUEST_INVALID",
    );
});
