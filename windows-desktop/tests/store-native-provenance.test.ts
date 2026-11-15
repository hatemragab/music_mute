import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCEPTANCE_CASES } from "../acceptance/manifest.js";
import { nativeAcceptanceSourceDigest } from "../acceptance/native-run.js";
import { caseDigest, targetDigest } from "../acceptance/plan.js";
import {
  parseStoreNativeBuildInputs,
  verifyStoreNativeProvenance,
  STORE_NATIVE_ROLE_FILES,
  type StoreNativeBuildInputs,
} from "../packaging/store/native-provenance.js";
const require = createRequire(import.meta.url),
  component = resolve(import.meta.dirname, "..");
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "musicmute-store-native-proof-")),
  );
  roots.push(root);
  return root;
}
function pe(execution = "asInvoker", machine = 0x8664) {
  const { NtExecutable, NtExecutableResource } =
    require("resedit") as typeof import("resedit");
  const executable = NtExecutable.createEmpty(false, false);
  executable.newHeader.fileHeader.machine = machine;
  const resources = NtExecutableResource.from(executable);
  resources.replaceResourceEntryFromString(
    24,
    1,
    1033,
    `<assembly><requestedExecutionLevel level="${execution}" uiAccess="false"/></assembly>`,
  );
  resources.outputResource(executable);
  return Buffer.from(executable.generate());
}
async function pinned(path: string, bytes: Buffer) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
  return { path, bytes: bytes.length, sha256: hash(bytes) };
}
/** Synthetic guarded-build records qualify only this unsigned source-staging
 * fixture. They never launch a binary or create actual Store/Windows evidence. */
async function inputs(
  root: string,
  machine = 0x8664,
  execution = "asInvoker",
  role: "gui" | "worker" = "worker",
): Promise<StoreNativeBuildInputs> {
  const nativeRoot = join(
      root,
      "native",
      "MusicMuteAcceptance-00000000-0000-4000-8000-000000000001",
    ),
    directory = join(nativeRoot, "native-build", "Release");
  const sourceSha256 = await nativeAcceptanceSourceDigest(
    resolve(component, ".."),
  );
  const target = {
    version: 2 as const,
    scope: "isolated-native" as const,
    name: "StoreGuiFixture",
    sourceSha256,
    os: {
      major: 10 as const,
      build: 26200,
      edition: "workstation" as const,
      nativeArch: "x64" as const,
      processArch: "x64" as const,
    },
    gpu: null,
  };
  const observation = await pinned(
    join(nativeRoot, "native-observation.json"),
    Buffer.from(
      JSON.stringify({
        version: 1,
        target,
        logs: ["configure", "compile", "describe", "ctest"].map((step) => ({
          step,
          exitCode: 0,
          toolExitCode: 0,
          terminationReason: "completed",
          bytes: 1,
          sha256: hash(Buffer.from("fixture")),
          sanitizedOutput: "Synthetic source-staging fixture only",
        })),
        failedToolDiagnostics: [],
        installedAppActionsExecuted: false,
      }) + "\n",
    ),
  );
  const evidence = ["native-build", "native-security-fixtures"].map((id) => ({
    version: 1,
    caseId: id,
    caseSha256: caseDigest(ACCEPTANCE_CASES.find((row) => row.id === id)!),
    targetSha256: targetDigest(target),
    source: "native",
    state: "passed",
    at: "2026-10-12T00:00:00.000Z",
    observation: "Synthetic source-staging fixture only",
    artifact: "native-observation.json",
    artifactSha256: observation.sha256,
    cleanup: "confirmed",
  }));
  const evidenceLedger = await pinned(
    join(nativeRoot, "evidence-ledger.json"),
    Buffer.from(JSON.stringify(evidence) + "\n"),
  );
  const executables = [];
  for (const name of STORE_NATIVE_ROLE_FILES[role]) {
    const entry = await pinned(join(directory, name), pe(execution, machine));
    executables.push({ ...entry, path: name });
  }
  return { directory, sourceSha256, observation, evidenceLedger, executables };
}
describe("shared Store native source proof", () => {
  it.each(["gui", "worker"] as const)(
    "admits only the exact %s fixture executable set with unsigned staging scope",
    async (role) => {
      const value = await inputs(await temporary(), 0x8664, "asInvoker", role);
      const proof = await verifyStoreNativeProvenance(value, role, component);
      expect(proof).toMatchObject({
        nativeCompilationAndIsolatedFixtures: "passed",
        installedStoreExecution: false,
        gpuQualification: false,
      });
      const parsed = parseStoreNativeBuildInputs(value, role);
      expect(Object.isFrozen(parsed.executables)).toBe(true);
    },
  );
  it("rejects foreign, self-labelled, reordered or missing executable authority before reading", async () => {
    const value = await inputs(await temporary());
    for (const changed of [
      { ...value, role: "worker" },
      { ...value, extra: true },
      { ...value, executables: value.executables.slice(1) },
      { ...value, executables: [...value.executables].reverse() },
      {
        ...value,
        executables: value.executables.map((row, index) =>
          index ? row : { ...row, path: "MusicMuteChromeHost.exe" },
        ),
      },
      {
        ...value,
        executables: value.executables.map((row, index) =>
          index ? row : { ...row, path: "../foreign.exe" },
        ),
      },
    ])
      expect(() => parseStoreNativeBuildInputs(changed, "worker")).toThrow();
    expect(() => parseStoreNativeBuildInputs(value, "gui")).toThrow();
    expect(() =>
      parseStoreNativeBuildInputs(value, "foreign" as "worker"),
    ).toThrow();
  });
  it("never invokes receiving getters and denies malformed pins and unrelated evidence paths", async () => {
    const value = await inputs(await temporary());
    let invoked = false;
    const getters = { ...value };
    Object.defineProperty(getters, "directory", {
      enumerable: true,
      get() {
        invoked = true;
        return value.directory;
      },
    });
    expect(() => parseStoreNativeBuildInputs(getters, "worker")).toThrow();
    expect(invoked).toBe(false);
    for (const bytes of [0, NaN, Infinity, 16 * 1024 ** 2 + 1])
      expect(() =>
        parseStoreNativeBuildInputs(
          {
            ...value,
            executables: value.executables.map((row, index) =>
              index ? row : { ...row, bytes },
            ),
          },
          "worker",
        ),
      ).toThrow();
    expect(() =>
      parseStoreNativeBuildInputs(
        {
          ...value,
          evidenceLedger: {
            ...value.evidenceLedger,
            path: join(awaitRoot(value), "foreign.json"),
          },
        },
        "worker",
      ),
    ).toThrow();
  });
  it.each([
    [0x14c, "asInvoker"],
    [0x8664, "requireAdministrator"],
  ])("denies real non-x64 or elevated PE bytes", async (machine, level) => {
    const value = await inputs(
      await temporary(),
      machine as number,
      level as string,
    );
    await expect(
      verifyStoreNativeProvenance(value, "worker", component),
    ).rejects.toThrow();
  });
  it("denies changed and multiply linked executable bytes despite a passing metadata fixture", async () => {
    const root = await temporary(),
      value = await inputs(root),
      file = join(value.directory, value.executables[0]!.path);
    await link(file, join(root, "alias.exe"));
    await expect(
      verifyStoreNativeProvenance(value, "worker", component),
    ).rejects.toThrow();
  });
  it("denies stale source and failed delivered tool evidence rather than relabelling old success", async () => {
    const value = await inputs(await temporary());
    await expect(
      verifyStoreNativeProvenance(
        { ...value, sourceSha256: "b".repeat(64) },
        "worker",
        component,
      ),
    ).rejects.toThrow("STORE_NATIVE_PROVENANCE_INVALID");
    const observation = JSON.parse(
      (await readFile(value.observation.path)).toString(),
    );
    observation.logs[3].toolExitCode = 8;
    const bytes = Buffer.from(JSON.stringify(observation));
    await writeFile(value.observation.path, bytes);
    await expect(
      verifyStoreNativeProvenance(
        {
          ...value,
          observation: {
            ...value.observation,
            bytes: bytes.length,
            sha256: hash(bytes),
          },
        },
        "worker",
        component,
      ),
    ).rejects.toThrow("STORE_NATIVE_PROVENANCE_INVALID");
  });
});
function awaitRoot(value: StoreNativeBuildInputs) {
  return resolve(value.observation.path, "..");
}
