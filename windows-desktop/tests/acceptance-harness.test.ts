import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ACCEPTANCE_CASES } from "../acceptance/manifest.js";
import {
  caseDigest,
  createAcceptancePlan,
  isIsolatedNativeAcceptanceCase,
  parseAcceptanceEvidence,
  parseAcceptanceTarget,
  targetDigest,
} from "../acceptance/plan.js";
import {
  assertNativeAcceptanceTarget,
  acceptanceLogExcerpt,
  parseAcceptanceNativeTools,
  runNativeAcceptance,
  nativeAcceptanceEnvironment,
  nativeAcceptanceSourceDigest,
} from "../acceptance/native-run.js";
import {
  acceptanceMain,
  parseAcceptanceInvocation,
} from "../acceptance/runner.js";
import { prepared } from "./fleet-fixtures.js";
const target = () => ({
  version: 1 as const,
  name: "fixture-win10-nvidia",
  os: {
    major: 10 as const,
    build: 19045,
    edition: "workstation" as const,
    nativeArch: "x64" as const,
    processArch: "x64" as const,
  },
  gpu: prepared().gpu,
  sourceSha256: "a".repeat(64),
  package: {
    appVersion: "0.1.0",
    payloadSha256: "b".repeat(64),
    installerSha256: "c".repeat(64),
    runtimeRelease: "fixture-release",
    manifestSha256: "d".repeat(64),
    modelSha256: "e".repeat(64),
  },
});
const nativeTarget = () => {
  const { name, os, gpu, sourceSha256 } = target();
  return {
    version: 2 as const,
    scope: "isolated-native" as const,
    name,
    os,
    gpu,
    sourceSha256,
  };
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it.each(["ARM64", "x86"])(
  "does not inherit %s architecture or compiler/toolchain or PATH injection into isolated native checks",
  (PROCESSOR_ARCHITECTURE) => {
    const env = nativeAcceptanceEnvironment({
      SystemRoot: "C:\\Windows",
      SystemDrive: "D:",
      PROCESSOR_ARCHITECTURE,
      PROCESSOR_ARCHITEW6432: "AMD64",
      TEMP: "C:\\Temp",
      ProgramData: "C:\\ProgramData",
      ALLUSERSPROFILE: "C:\\ProgramData",
      PATH: "C:\\untrusted",
      CMAKE_TOOLCHAIN_FILE: "arbitrary.cmake",
      CMAKE_GENERATOR_INSTANCE: "C:\\foreign",
      CXX: "foreign.exe",
      CL: "/FIforeign.h",
      NODE_OPTIONS: "--inspect",
      INCLUDE: "C:\\foreign",
      MSBuildSDKsPath: "C:\\foreign",
      MSBUILD_EXE_PATH: "C:\\foreign\\MSBuild.exe",
    });
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows");
    expect(env.SystemDrive).toBe("C:");
    expect(env.PROCESSOR_ARCHITECTURE).toBe("AMD64");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env.ProgramData).toBe("C:\\ProgramData");
    expect(env.ALLUSERSPROFILE).toBe("C:\\ProgramData");
    for (const name of [
      "CMAKE_TOOLCHAIN_FILE",
      "CMAKE_GENERATOR_INSTANCE",
      "CXX",
      "CL",
      "NODE_OPTIONS",
      "INCLUDE",
      "MSBuildSDKsPath",
      "MSBUILD_EXE_PATH",
      "PROCESSOR_ARCHITEW6432",
    ])
      expect(env[name]).toBeUndefined();
  },
);
it("derives the native tool system drive from the Windows directory", () => {
  expect(
    nativeAcceptanceEnvironment({
      SystemRoot: "D:\\Windows",
      SystemDrive: "C:",
    }).SystemDrive,
  ).toBe("D:");
});
it.each(["\\\\server\\share\\Windows", "\\Windows", "Windows", "C:Windows"])(
  "rejects a Windows directory without an absolute local drive: %s",
  (SystemRoot) => {
    expect(() =>
      nativeAcceptanceEnvironment({ SystemRoot, SystemDrive: "C:" }),
    ).toThrow("ACCEPTANCE_TOOL_INVALID");
  },
);
it("binds the closed native source inventory and refuses ignored arbitrary build inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-qa-source-code-"));
  roots.push(root);
  const dir = join(root, "worker/native/windows-consumer");
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  for (const name of ["CMakeLists.txt", "main.cpp", "native_tests.cpp"])
    await writeFile(join(dir, name), "synthetic source fixture");
  const digest = await nativeAcceptanceSourceDigest(root);
  expect(digest).toMatch(/^[a-f0-9]{64}$/u);
  await writeFile(
    join(dir, "extra-toolchain.cmake"),
    "synthetic unexpected build input",
  );
  await expect(nativeAcceptanceSourceDigest(root)).rejects.toThrow(
    "ACCEPTANCE_SOURCE_INVALID",
  );
});
it("covers all 30 accepted points and keeps app/live/destructive cases out of the native action grammar", () => {
  const points = new Set(ACCEPTANCE_CASES.flatMap((row) => row.points));
  expect([...points].sort()).toEqual(
    Array.from({ length: 30 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`),
  );
  expect(new Set(ACCEPTANCE_CASES.map((row) => row.id)).size).toBe(
    ACCEPTANCE_CASES.length,
  );
  expect(
    ACCEPTANCE_CASES.filter((row) => row.action !== "manual").map(
      (row) => row.id,
    ),
  ).toEqual(["native-build", "native-security-fixtures"]);
  for (const id of [
    "installer",
    "account",
    "explicit-purge-revoke",
    "release-acceptance",
  ])
    expect(() =>
      parseAcceptanceInvocation([
        "run-native",
        "/target.json",
        "/tools.json",
        "/reports",
        id,
        "--acknowledge-windows-phase",
      ]),
    ).toThrow("ACCEPTANCE_ACTION_DENIED");
});
it("maps manual point cases to the authoritative accepted scope and owning tasks", async () => {
  const coverage = await readFile(
    new URL("../../docs/windows-desktop/COVERAGE.md", import.meta.url),
    "utf8",
  );
  const owners = new Map(
    coverage
      .split("\n")
      .filter((line) => /^\| P\d{2}\s*\|/u.test(line))
      .map((line) => {
        const cells = line.split("|");
        return [
          cells[1]!.trim(),
          new Set(cells[4]!.match(/W\d{2}/gu)),
        ] as const;
      }),
  );
  expect(owners.size).toBe(30);
  const manual = ACCEPTANCE_CASES.filter((row) => row.action === "manual"),
    covered = new Set<string>();
  for (const definition of manual)
    for (const point of definition.points) {
      expect(owners.get(point)?.has(definition.task), definition.id).toBe(true);
      covered.add(point);
    }
  expect([...covered].sort()).toEqual([...owners.keys()].sort());
  expect(manual.find((row) => row.id === "guest-local")?.points).toEqual([
    "P08",
  ]);
  expect(manual.find((row) => row.id === "gpu-coordination")?.points).toEqual([
    "P22",
  ]);
});
it("cannot reuse a previous mislabeled login case as proof of the corrected point", () => {
  const row = target(),
    definition = ACCEPTANCE_CASES.find(
      (entry) => entry.id === "login-lifetime",
    )!,
    oldDefinition = { ...definition, revision: 1, points: ["P08"] };
  const previous = {
    version: 1,
    caseId: definition.id,
    caseSha256: caseDigest(oldDefinition),
    targetSha256: targetDigest(row),
    source: "native",
    state: "passed",
    at: "2026-10-10T00:00:00.000Z",
    observation: "Synthetic old-case ledger fixture only.",
    artifact: "fixture.json",
    artifactSha256: "f".repeat(64),
    cleanup: "confirmed",
  };
  const result = createAcceptancePlan(row, [definition.id], [], [previous]);
  expect(result.cases[0]?.definition.points).toEqual(["P25"]);
  expect(result.cases[0]?.disposition).toBe("authorization-required");
});
it("a procedure-only expansion invalidates a partial native attestation even with identical target, case ID, revision and artifacts", () => {
  const row = target();
  const definition = ACCEPTANCE_CASES.find(
    (entry) => entry.id === "chrome-registration",
  )!;
  const priorDefinition = {
    ...definition,
    procedure: "Prior incomplete registration procedure fixture.",
  };
  const previous = {
    version: 1,
    caseId: definition.id,
    caseSha256: caseDigest(priorDefinition),
    targetSha256: targetDigest(row),
    source: "native",
    state: "passed",
    at: "2026-10-10T00:00:00.000Z",
    observation: "Synthetic partial-attestation policy fixture only.",
    artifact: "fixture.json",
    artifactSha256: "f".repeat(64),
    cleanup: "confirmed",
  };
  expect(caseDigest(priorDefinition)).not.toBe(caseDigest(definition));
  const result = createAcceptancePlan(row, [definition.id], [], [previous]);
  expect(result.cases[0]?.disposition).toBe("authorization-required");
});
it("refuses unspecified, old, server, ARM and emulated target reports", () => {
  for (const change of [
    { build: 19044 },
    { nativeArch: "arm64" },
    { processArch: "x86" },
    { edition: "server" },
    { major: 6 },
  ])
    expect(() =>
      parseAcceptanceTarget({ ...target(), os: { ...target().os, ...change } }),
    ).toThrow("ACCEPTANCE_UNSUPPORTED_TARGET");
  const row = target();
  delete (row as Partial<typeof row>).package;
  expect(() => parseAcceptanceTarget(row)).toThrow("ACCEPTANCE_INVALID");
  expect(() => createAcceptancePlan(target(), ["unknown"])).toThrow(
    "ACCEPTANCE_UNKNOWN_CASE",
  );
});
it("accepts a closed isolated-native target without candidate metadata and preserves the original candidate fingerprint", () => {
  const candidate = { ...target(), gpu: null },
    native = nativeTarget();
  expect(parseAcceptanceTarget(candidate)).toEqual(candidate);
  expect(targetDigest(candidate)).toBe(
    "8bfa84ec6b45048ce616f371b542d823fea5a0d049bbeda6937aacfea8242419",
  );
  for (const row of [native, { ...native, gpu: null }])
    expect(parseAcceptanceTarget(row)).toEqual(row);
  expect(targetDigest(native)).not.toBe(targetDigest(target()));
  for (const row of [
    { ...native, package: target().package },
    { ...native, package: null },
    { ...native, scope: undefined },
    { ...native, scope: "candidate" },
    { ...native, version: 1 },
    { ...native, unknown: true },
    { ...target(), version: 2 },
    { ...target(), scope: "isolated-native" },
  ])
    expect(() => parseAcceptanceTarget(row)).toThrow("ACCEPTANCE_INVALID");
  const withoutScope: Partial<ReturnType<typeof nativeTarget>> = { ...native };
  delete withoutScope.scope;
  expect(() => parseAcceptanceTarget(withoutScope)).toThrow(
    "ACCEPTANCE_INVALID",
  );
  for (const change of [
    { build: 19044 },
    { nativeArch: "arm64" },
    { processArch: "x86" },
    { edition: "server" },
    { major: 6 },
  ])
    expect(() =>
      parseAcceptanceTarget({ ...native, os: { ...native.os, ...change } }),
    ).toThrow("ACCEPTANCE_UNSUPPORTED_TARGET");
  const accessor = vi.fn(() => 2),
    hostile = { ...native };
  Object.defineProperty(hostile, "version", { get: accessor });
  expect(() => parseAcceptanceTarget(hostile)).toThrow("ACCEPTANCE_INVALID");
  expect(accessor).not.toHaveBeenCalled();
});
it("keeps every installed or manual case candidate-required despite authorization and rejects exact native-only passed evidence", () => {
  const row = nativeTarget(),
    nativeCases = ACCEPTANCE_CASES.filter(isIsolatedNativeAcceptanceCase),
    candidateCases = ACCEPTANCE_CASES.filter(
      (definition) => !isIsolatedNativeAcceptanceCase(definition),
    );
  expect(nativeCases.map((definition) => definition.id)).toEqual([
    "native-build",
    "native-security-fixtures",
  ]);
  expect(
    isIsolatedNativeAcceptanceCase({ ...nativeCases[0]!, action: "manual" }),
  ).toBe(false);
  expect(
    isIsolatedNativeAcceptanceCase({ ...nativeCases[0]!, id: "future-case" }),
  ).toBe(false);
  const plan = createAcceptancePlan(
    row,
    undefined,
    ACCEPTANCE_CASES.map((definition) => definition.id),
  );
  for (const definition of candidateCases) {
    expect(
      plan.cases.find((entry) => entry.definition.id === definition.id)
        ?.disposition,
    ).toBe("candidate-required");
    const evidence = {
      version: 1,
      caseId: definition.id,
      caseSha256: caseDigest(definition),
      targetSha256: targetDigest(row),
      source: "native",
      state: "passed",
      at: "2026-10-11T00:00:00.000Z",
      observation: "Synthetic scope-denial ledger fixture only.",
      artifact: "fixture.json",
      artifactSha256: "f".repeat(64),
      cleanup: "confirmed",
    };
    expect(() =>
      createAcceptancePlan(row, ["native-build"], [definition.id], [evidence]),
    ).toThrow("ACCEPTANCE_CANDIDATE_REQUIRED");
    expect(
      createAcceptancePlan(
        row,
        [definition.id],
        [],
        [{ ...evidence, state: "failed", cleanup: "unconfirmed" }],
      ).cases[0]?.disposition,
    ).toBe("candidate-required");
    expect(
      createAcceptancePlan(
        row,
        [definition.id],
        [],
        [{ ...evidence, targetSha256: targetDigest(target()) }],
      ).cases[0]?.disposition,
    ).toBe("candidate-required");
  }
  for (const definition of nativeCases)
    expect(
      plan.cases.find((entry) => entry.definition.id === definition.id)
        ?.disposition,
    ).toBe("pending");
});
it("resumes isolated native proof only on its exact scope, source, hardware and case fingerprint", () => {
  const row = nativeTarget();
  for (const definition of ACCEPTANCE_CASES.filter(
    isIsolatedNativeAcceptanceCase,
  )) {
    const evidence = {
      version: 1,
      caseId: definition.id,
      caseSha256: caseDigest(definition),
      targetSha256: targetDigest(row),
      source: "native",
      state: "passed",
      at: "2026-10-11T00:00:00.000Z",
      observation: "Synthetic exact-target resume fixture only.",
      artifact: "fixture.json",
      artifactSha256: "f".repeat(64),
      cleanup: "confirmed",
    };
    expect(
      createAcceptancePlan(row, [definition.id], [], [evidence]).cases[0]
        ?.disposition,
    ).toBe("completed-on-exact-target");
    for (const changed of [
      target(),
      { ...row, os: { ...row.os, build: 22631 } },
      { ...row, sourceSha256: "f".repeat(64) },
      { ...row, gpu: { ...row.gpu, driverVersion: "31.0.0.2" } },
    ])
      expect(
        createAcceptancePlan(changed, [definition.id], [], [evidence]).cases[0]
          ?.disposition,
      ).toBe("authorization-required");
    for (const changed of [
      { ...evidence, caseSha256: "f".repeat(64) },
      { ...evidence, targetSha256: targetDigest(target()) },
    ])
      expect(
        createAcceptancePlan(row, [definition.id], [], [changed]).cases[0]
          ?.disposition,
      ).toBe("authorization-required");
  }
});
it("resumes only an explicitly attested native pass on exact OS/GPU/source/artifacts and unchanged case", () => {
  const row = target(),
    definition = ACCEPTANCE_CASES[0]!,
    previous = {
      version: 1,
      caseId: definition.id,
      caseSha256: caseDigest(definition),
      targetSha256: targetDigest(row),
      source: "native",
      state: "passed",
      at: "2026-10-09T12:00:00.000Z",
      observation:
        "Synthetic prior ledger fixture; no Windows action ran in this test.",
      artifact: "fixture.json",
      artifactSha256: "f".repeat(64),
      cleanup: "confirmed",
    };
  expect(
    createAcceptancePlan(row, [definition.id], [], [previous]).cases[0]!
      .disposition,
  ).toBe("completed-on-exact-target");
  for (const changed of [
    { ...row, os: { ...row.os, build: 22631 } },
    { ...row, sourceSha256: "f".repeat(64) },
    { ...row, gpu: { ...row.gpu, driverVersion: "31.0.0.2" } },
    { ...row, package: { ...row.package, modelSha256: "f".repeat(64) } },
  ])
    expect(
      createAcceptancePlan(changed, [definition.id], [], [previous]).cases[0]!
        .disposition,
    ).toBe("authorization-required");
  expect(
    createAcceptancePlan(
      row,
      [definition.id],
      [],
      [{ ...previous, caseSha256: "f".repeat(64) }],
    ).cases[0]!.disposition,
  ).toBe("authorization-required");
  expect(() =>
    parseAcceptanceEvidence({ ...previous, source: "simulated" }),
  ).toThrow("ACCEPTANCE_UNPROVEN_PASS");
  for (const cleanup of ["unconfirmed", "not-applicable"])
    expect(() => parseAcceptanceEvidence({ ...previous, cleanup })).toThrow(
      "ACCEPTANCE_UNPROVEN_PASS",
    );
});
it("rejects unbounded/private evidence and unsafe references without persisting raw logs", () => {
  const row = {
    version: 1,
    caseId: "native-build",
    caseSha256: "a".repeat(64),
    targetSha256: "b".repeat(64),
    source: "simulated",
    state: "failed",
    at: "2026-10-09T12:00:00.000Z",
    observation: "fixture",
    artifact: "safe.json",
    artifactSha256: "f".repeat(64),
    cleanup: "unconfirmed",
  };
  for (const observation of [
    "https://private.invalid/grant",
    "Bearer private-token",
    "C:\\Users\\Private\\media.mp3",
    "name@private.invalid",
    "S-1-5-21-1-2-3-1001",
    "access_token=fixture-secret",
    "api_key:fixture-secret",
    "Authorization:fixture-secret",
  ])
    expect(() => parseAcceptanceEvidence({ ...row, observation })).toThrow(
      "ACCEPTANCE_PRIVATE_EVIDENCE",
    );
  expect(() =>
    parseAcceptanceEvidence({ ...row, artifact: "../foreign.json" }),
  ).toThrow("ACCEPTANCE_INVALID");
  const log = acceptanceLogExcerpt(
    Buffer.from(
      "C:\\Users\\Private Name\\repo\\worker\\native\\main.cpp error: fixture\nC:\\Users\\Private Name\\AppData S-1-5-21-1-2-3-1001 https://private.invalid/grant Bearer private-token",
    ),
    "C:\\Users\\Private Name\\repo",
    "C:\\Users\\Private Name",
  );
  expect(log).toContain("[REPOSITORY]");
  expect(log).not.toContain("Private Name");
  expect(log).not.toContain("private-token");
  expect(log).not.toContain("S-1-5-21");
  expect(log).not.toContain("https://");
  expect(() =>
    parseAcceptanceEvidence({ ...row, observation: "x".repeat(2049) }),
  ).toThrow("ACCEPTANCE_INVALID");
});
it("rejects non-string evidence enums without invoking coercion hooks", () => {
  const value = {
    version: 1,
    caseId: "native-build",
    caseSha256: "a".repeat(64),
    targetSha256: "b".repeat(64),
    source: "simulated",
    state: "failed",
    at: "2026-10-10T00:00:00.000Z",
    observation: "fixture",
    artifact: null,
    artifactSha256: null,
    cleanup: "unconfirmed",
  };
  const coercion = vi.fn(() => "native"),
    hostile = { toString: coercion };
  for (const key of ["caseId", "source", "state", "cleanup"])
    expect(() => parseAcceptanceEvidence({ ...value, [key]: hostile })).toThrow(
      "ACCEPTANCE_INVALID",
    );
  expect(coercion).not.toHaveBeenCalled();
});
it("closed CLI never accepts arbitrary commands/paths or native execution without acknowledgement", () => {
  for (const argv of [
    [],
    ["run-native", "/target.json", "/tools.json", "/reports", "native-build"],
    ["shell", "cmd.exe", "/c", "anything"],
    ["plan", "relative.json", "/reports"],
    ["plan", "/target.json", "/reports", "/prior.json", "extra"],
  ])
    expect(() => parseAcceptanceInvocation(argv)).toThrow(
      "ACCEPTANCE_ARGUMENT_INVALID",
    );
  expect(() =>
    parseAcceptanceNativeTools({
      version: 1,
      cmake: { path: resolve("powershell.exe"), sha256: "a".repeat(64) },
      ctest: { path: resolve("ctest.exe"), sha256: "a".repeat(64) },
    }),
  ).toThrow("ACCEPTANCE_TOOL_INVALID");
});
it("actual native description binds full reported hardware/ordinal/driver and OS instead of trusting plan labels", () => {
  const row = target(),
    description = { version: 1, ...row.os, gpus: [row.gpu] };
  expect(() => assertNativeAcceptanceTarget(row, description)).not.toThrow();
  expect(() =>
    assertNativeAcceptanceTarget(nativeTarget(), description),
  ).not.toThrow();
  expect(() =>
    assertNativeAcceptanceTarget(row, { ...description, nativeArch: "arm64" }),
  ).toThrow("ACCEPTANCE_TARGET_MISMATCH");
  expect(() =>
    assertNativeAcceptanceTarget(row, {
      ...description,
      gpus: [{ ...row.gpu, deviceIndex: 1 }],
    }),
  ).toThrow("ACCEPTANCE_TARGET_MISMATCH");
});
it("native-only planning writes explicit candidate blockers and rejects even independently hashed manual pass imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-native-plan-fixture-"));
  roots.push(root);
  const row = nativeTarget(),
    file = join(root, "target.json"),
    definition = ACCEPTANCE_CASES.find((entry) => entry.id === "installer")!;
  await writeFile(file, JSON.stringify(row));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await acceptanceMain(["plan", file, root], resolve("."));
  const folder = (await readdir(root)).find((name) =>
    name.startsWith("MusicMuteAcceptancePlan-"),
  )!;
  const plan = JSON.parse(
    await readFile(join(root, folder, "acceptance-plan.json"), "utf8"),
  );
  expect(plan.target).toEqual(row);
  expect(plan.windowsExecuted).toBe(false);
  expect(
    plan.cases.find(
      (entry: { definition: { id: string } }) =>
        entry.definition.id === definition.id,
    ).disposition,
  ).toBe("candidate-required");
  const artifact = Buffer.from("Synthetic scope-denial proof artifact only.");
  await writeFile(join(root, "proof.json"), artifact);
  await writeFile(
    join(root, "prior.json"),
    JSON.stringify([
      {
        version: 1,
        caseId: definition.id,
        caseSha256: caseDigest(definition),
        targetSha256: targetDigest(row),
        source: "native",
        state: "passed",
        at: "2026-10-11T00:00:00.000Z",
        observation: "Synthetic installed-pass denial fixture only.",
        artifact: "proof.json",
        artifactSha256: createHash("sha256").update(artifact).digest("hex"),
        cleanup: "confirmed",
      },
    ]),
  );
  await expect(
    acceptanceMain(
      ["plan", file, root, join(root, "prior.json")],
      resolve("."),
    ),
  ).rejects.toThrow("ACCEPTANCE_CANDIDATE_REQUIRED");
  expect(
    (await readdir(root)).filter((name) =>
      name.startsWith("MusicMuteAcceptancePlan-"),
    ),
  ).toEqual([folder]);
});
it("planning CLI writes only pending cases and no Windows result in an exclusive disposable report folder", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-acceptance-plan-code-fixture-"),
  );
  roots.push(root);
  await writeFile(join(root, "target.json"), JSON.stringify(target()));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await acceptanceMain(["plan", join(root, "target.json"), root], resolve("."));
  const directory = (await readdir(root)).find((name) =>
    name.startsWith("MusicMuteAcceptancePlan-"),
  )!;
  const plan = JSON.parse(
    await readFile(join(root, directory, "acceptance-plan.json"), "utf8"),
  );
  expect(plan.windowsExecuted).toBe(false);
  expect(plan.cases).toHaveLength(ACCEPTANCE_CASES.length);
  expect(
    plan.cases.every(
      (row: { disposition: string }) =>
        row.disposition === "authorization-required",
    ),
  ).toBe(true);
  if (process.platform !== "win32")
    await expect(
      runNativeAcceptance({
        repository: resolve(".."),
        outputRoot: root,
        target: target(),
        tools: {},
        cases: ["native-build"],
        acknowledgeWindowsPhase: true,
      }),
    ).rejects.toThrow("ACCEPTANCE_WINDOWS_PHASE_REQUIRED");
  expect(
    (await readdir(root)).filter((name) =>
      name.startsWith("MusicMuteAcceptance-"),
    ),
  ).toEqual([]);
});
it("planning resume verifies the referenced artifact digest instead of carrying a missing or changed report", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-acceptance-evidence-fixture-"),
  );
  roots.push(root);
  const row = target(),
    definition = ACCEPTANCE_CASES[0]!;
  await writeFile(join(root, "target.json"), JSON.stringify(row));
  await writeFile(join(root, "proof.json"), "changed fixture proof");
  await writeFile(
    join(root, "prior.json"),
    JSON.stringify([
      {
        version: 1,
        caseId: definition.id,
        caseSha256: caseDigest(definition),
        targetSha256: targetDigest(row),
        source: "native",
        state: "passed",
        at: "2026-10-09T12:00:00.000Z",
        observation: "Synthetic resume policy fixture only.",
        artifact: "proof.json",
        artifactSha256: "f".repeat(64),
        cleanup: "confirmed",
      },
    ]),
  );
  await expect(
    acceptanceMain(
      ["plan", join(root, "target.json"), root, join(root, "prior.json")],
      resolve("."),
    ),
  ).rejects.toThrow("ACCEPTANCE_ARTIFACT_MISMATCH");
  expect(
    (await readdir(root)).some((name) =>
      name.startsWith("MusicMuteAcceptancePlan-"),
    ),
  ).toBe(false);
});
import { createHash } from "node:crypto";
