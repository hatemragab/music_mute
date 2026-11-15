import { mkdtemp, mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { processIdentity } from "./fleet-advanced-fixtures.js";
import type { WindowsDiagnosticIdentity } from "../src/shared/diagnostics-contracts.js";
export const diagnosticIdentity: WindowsDiagnosticIdentity = {
  softwareVersion: "0.1.0",
  runtimeScope: "packaged-app",
  expectedModelSha256: MODEL.sha256,
  packageInventorySha256: "a".repeat(64),
};
export async function diagnosticFixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-diagnostics-")),
    path = (relative: string) => join(root, ...relative.split("\\"));
  const native = {
    openPrivateFile: vi.fn(
      privateFileNativeFixture((relative) =>
        join(root, relative.replaceAll("\\", "/")),
      ).openPrivateFile,
    ),
    identity: vi.fn(async () => ({
      ...processIdentity,
      nativeArch: "x64",
      processArch: "x64",
      osMajor: 10,
      osBuild: 19045,
      logonSid: "S-1-5-5-1-2",
      localAppData: "C:\\Users\\fixture\\AppData\\Local",
    })),
    acquireMutex: vi.fn(async (scope: string) => ({
      scope,
      identity: processIdentity,
      nonce: "f".repeat(64),
      abandoned: false,
    })),
    releaseMutex: vi.fn(async () => {}),
    validatePath: vi.fn(async (_ns: string, relative: string, kind: string) => {
      if (kind === "absent") {
        try {
          await lstat(path(relative));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
          throw e;
        }
        throw new Error("PATH_UNSAFE");
      }
      const s = await lstat(path(relative));
      if (
        s.isSymbolicLink() ||
        (kind === "file" ? !s.isFile() || s.nlink !== 1 : !s.isDirectory())
      )
        throw new Error("PATH_UNSAFE");
    }),
    enumerateGpus: vi.fn(async () => []),
    ownedTreeExited: vi.fn(async () => true),
    processIdentity: vi.fn(async (pid: number) =>
      pid === process.pid ? { ...processIdentity, pid } : null,
    ),
  };
  const host = {
    personalRoot: root,
    identity: processIdentity,
    native,
    directory: async (relative: string) => {
      await mkdir(path(relative), { recursive: true, mode: 0o700 });
      return path(relative);
    },
  } as unknown as HostContext;
  return { root, path, native, host };
}
