import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  parseStoreWorkerBuildInputs,
  parseStoreWorkerBuildInputsBytes,
  parseStoreAcquisitionPins,
  buildStoreWorkerDirectory,
  copyStorePinnedFile,
  STORE_WORKER_DEVELOPMENT_OMISSIONS,
  assertStoreWorkerDevelopmentOmission,
  assertStoreWorkerDevelopmentCurationCensus,
} from "../packaging/store/worker.js";
import {
  parseStoreYoutubeIdentity,
  STORE_ACQUISITION_PINS,
  STORE_PERSONAL_ENTRY,
  STORE_QUALIFICATION_ENTRY,
  STORE_CODE_READER,
  STORE_DOWNLOADER_ENTRY,
  verifyStoreWorkerProtectedAdapters,
} from "../packaging/store/acquisition.js";
import {
  STORE_PNPM_TOOL,
  storePnpmArchiveFiles,
  storePnpmEnvironment,
  storePnpmInstallArguments,
  storePnpmFetchArguments,
  prepareStoreProductionDependencyCache,
} from "../packaging/store/pnpm.js";
import { STORE_NATIVE_ROLE_FILES } from "../packaging/store/native-provenance.js";
import { WINDOWS_CONSUMER_PINS } from "../../worker/src/platform/windows/consumer-pins.js";
import { parseStoreBuildDocument } from "../packaging/store/document-json.js";
import {
  STORE_PYTHON_OMISSIONS,
  assertStorePythonOmission,
  createStorePythonProjection,
  parseStorePythonProjectionReceipt,
  STORE_SAMPLERATE_BINDING,
  STORE_SAMPLERATE_LIBRARY,
} from "../packaging/store/python-projection.js";

const component = resolve(import.meta.dirname, ".."),
  root = resolve(component, "../store-source-fixture");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)),
  empty = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const pin = (path: string) => ({ path, bytes: 1, sha256: "a".repeat(64) });
describe("finite fresh Store development-input curation", () => {
  it("selects only27 exact known leaves and keeps retained Torch import resources outside the omission set", () => {
    expect(STORE_WORKER_DEVELOPMENT_OMISSIONS).toHaveLength(27);
    for (const row of STORE_WORKER_DEVELOPMENT_OMISSIONS) {
      expect(assertStoreWorkerDevelopmentOmission(row)).toEqual(row);
      for (const changed of [
        { ...row, path: row.path + ".unknown" },
        { ...row, bytes: row.bytes + 1 },
        { ...row, sha256: "a".repeat(64) },
        { ...row, extra: true },
      ])
        expect(() => assertStoreWorkerDevelopmentOmission(changed)).toThrow();
    }
    expect(() =>
      assertStoreWorkerDevelopmentOmission({
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/user_input_mutation.py",
        bytes: 394,
        sha256: "a".repeat(64),
      }),
    ).toThrow();
    expect(
      STORE_WORKER_DEVELOPMENT_OMISSIONS.filter((p) =>
        p.path.startsWith("app/node_modules/gensync/test/"),
      ),
    ).toHaveLength(2);
    expect(
      STORE_WORKER_DEVELOPMENT_OMISSIONS.filter((p) => p.path.endsWith(".whl")),
    ).toHaveLength(2);
    expect(
      STORE_WORKER_DEVELOPMENT_OMISSIONS.filter((p) =>
        p.path.includes("/examples/"),
      ),
    ).toHaveLength(23);
  });
  it("proves every remaining file and directory byte-for-byte and denies any unknown omission or retained mutation", () => {
    const retained = [
        {
          path: "runtime/python/Lib/site-packages/numpy",
          kind: "directory" as const,
        },
        {
          path: "runtime/python/Lib/site-packages/numpy/__init__.py",
          kind: "file" as const,
          bytes: 10,
          sha256: "a".repeat(64),
        },
        {
          path: "runtime/python/Lib/site-packages/torch/_export/db/examples/user_input_mutation.py",
          kind: "file" as const,
          bytes: 394,
          sha256: "b".repeat(64),
        },
      ],
      before = [
        ...STORE_WORKER_DEVELOPMENT_OMISSIONS.map((p) => ({
          ...p,
          kind: "file" as const,
        })),
        ...retained,
      ];
    expect(() =>
      assertStoreWorkerDevelopmentCurationCensus(before, retained),
    ).not.toThrow();
    const first = STORE_WORKER_DEVELOPMENT_OMISSIONS[0]!;
    for (const [b, a] of [
      [before.slice(1), retained],
      [
        before.map((p) =>
          p.path === first.path
            ? {
                ...p,
                kind: "file" as const,
                bytes: first.bytes + 1,
                sha256: first.sha256,
              }
            : p,
        ),
        retained,
      ],
      [before, retained.slice(1)],
      [before, retained.slice(0, 1)],
      [before, [...retained, { ...first, kind: "file" as const }]],
      [
        before,
        [
          ...retained,
          {
            path: "unknown.py",
            kind: "file" as const,
            bytes: 1,
            sha256: "a".repeat(64),
          },
        ],
      ],
      [
        before,
        retained.map((p) =>
          p.kind === "file" ? { ...p, sha256: "c".repeat(64) } : p,
        ),
      ],
    ] as const)
      expect(() => assertStoreWorkerDevelopmentCurationCensus(b, a)).toThrow();
  });
});
function inputs() {
  const cohort = join(root, "acquisition"),
    nativeRoot = join(root, "native");
  return {
    version: 1,
    purpose: "unsigned-store-worker-directory",
    appBuildNumber: 1,
    nodeRoot: join(root, "node"),
    pythonRoot: join(root, "python"),
    pythonProjection: pin(
      join(root, "python-build-work/python-projection-receipt.json"),
    ),
    mediaRoot: join(root, "media"),
    pnpmToolRoot: join(root, "pnpm"),
    pnpmStoreRoot: join(root, "store"),
    nativeBuild: {
      directory: join(nativeRoot, "native-build/Release"),
      sourceSha256: "a".repeat(64),
      observation: pin(join(nativeRoot, "native-observation.json")),
      evidenceLedger: pin(join(nativeRoot, "evidence-ledger.json")),
      executables: STORE_NATIVE_ROLE_FILES.worker.map(pin),
    },
    acquisition: {
      root: cohort,
      qualification: pin(join(cohort, "qualification.json")),
      guardianReceipt: pin(join(cohort, "guarded-build-receipt.json")),
      readonlyReceipt: pin(
        join(cohort, "build-work/readonly-code-rehearsal.json"),
      ),
      codePins: pin(join(cohort, "build-work/relocated-before-pins.json")),
      cachePins: pin(
        join(cohort, "build-work/fixed-deno-cache-before-pins.json"),
      ),
    },
  };
}
function youtube() {
  const files = [
    {
      path: "bin/deno.exe",
      bytes: STORE_ACQUISITION_PINS.denoExecutableBytes,
      sha256: STORE_ACQUISITION_PINS.denoExecutableSha256,
    },
    {
      path: "provider/src/generate_once.ts",
      bytes: 1,
      sha256: WINDOWS_CONSUMER_PINS.providerScriptSha256,
    },
    {
      path: "provider/src/session_manager.ts",
      bytes: 1,
      sha256: WINDOWS_CONSUMER_PINS.providerSessionSha256,
    },
    {
      path: "provider/deno.lock",
      bytes: 1,
      sha256: STORE_ACQUISITION_PINS.productionLockSha256,
    },
    {
      path: "provider/deno.json",
      bytes: 1,
      sha256: STORE_ACQUISITION_PINS.manualHoistedConfigurationSha256,
    },
    { path: "provider/LICENSE", bytes: 1, sha256: "a".repeat(64) },
    { path: "licenses/deno/LICENSE", bytes: 1, sha256: "a".repeat(64) },
    { path: "deno-cache/gen/source.js", bytes: 1, sha256: "a".repeat(64) },
    ...[1, 2, 3].map((index) => ({
      path: `provider/node_modules/fixture-${index}/package.json`,
      bytes: 1,
      sha256: "a".repeat(64),
    })),
  ];
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    schema_version: 1,
    platform: "win32",
    arch: "x64",
    deno_version: WINDOWS_CONSUMER_PINS.deno,
    provider_version: WINDOWS_CONSUMER_PINS.provider,
    sources: { scope: "receiving-fixture-only-no-execution" },
    files,
  };
}
describe("Store-only Worker source staging", () => {
  it("binds every fixed protected adapter to current source and rejects a missing or changed personal wrapper", async () => {
    const folder = await realpath(
        await mkdtemp(join(tmpdir(), "store-protected-adapters-")),
      ),
      componentRoot = join(folder, "repository/windows-desktop"),
      payload = join(folder, "payload"),
      entries = [
        [
          join(
            folder,
            "repository/chrome-extension/engine",
            STORE_DOWNLOADER_ENTRY,
          ),
          join(payload, "tools/downloader", STORE_DOWNLOADER_ENTRY),
        ],
        ...[
          STORE_CODE_READER,
          STORE_PERSONAL_ENTRY,
          STORE_QUALIFICATION_ENTRY,
        ].map(
          (name) =>
            [
              join(folder, "repository/worker/engine/musicmute_engine", name),
              join(payload, "app/engine/musicmute_engine", name),
            ] as const,
        ),
      ] as const;
    try {
      await mkdir(componentRoot, { recursive: true });
      for (const [source, target] of entries) {
        await mkdir(join(source, ".."), { recursive: true });
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(source, "# current protected source\n");
        await writeFile(target, "# current protected source\n");
      }
      await verifyStoreWorkerProtectedAdapters(payload, componentRoot);
      const qualification = join(
          payload,
          "app/engine/musicmute_engine",
          STORE_QUALIFICATION_ENTRY,
        ),
        qualified = await readFile(qualification);
      await writeFile(qualification, "# stale qualification wrapper\n");
      await expect(
        verifyStoreWorkerProtectedAdapters(payload, componentRoot),
      ).rejects.toThrow("STORE_ACQUISITION_INVALID");
      await rm(qualification);
      await expect(
        verifyStoreWorkerProtectedAdapters(payload, componentRoot),
      ).rejects.toThrow();
      await writeFile(qualification, qualified);
      const wrapper = join(
        payload,
        "app/engine/musicmute_engine",
        STORE_PERSONAL_ENTRY,
      );
      await writeFile(wrapper, "# stale wrapper\n");
      await expect(
        verifyStoreWorkerProtectedAdapters(payload, componentRoot),
      ).rejects.toThrow("STORE_ACQUISITION_INVALID");
      await rm(wrapper);
      await expect(
        verifyStoreWorkerProtectedAdapters(payload, componentRoot),
      ).rejects.toThrow();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it("receives exact projection/ABI evidence without granting readiness or accepting mismatched DLL and distribution proofs", async () => {
    const requirements = await readFile(
        join(
          component,
          "../tools/worker-gpu-feasibility/requirements-directml.lock.txt",
        ),
      ),
      packages = Object.fromEntries(
        requirements
          .toString()
          .trim()
          .split(/\r?\n/u)
          .map((line) => {
            const [k, v] = line.split("==");
            return [k!.toLowerCase().replaceAll(/[-_.]+/gu, "-"), v];
          }),
      ),
      source = join(root, "raw-python"),
      projection = join(root, "projected-python");
    const probe = (path: string) => ({
      python: WINDOWS_CONSUMER_PINS.python,
      architecture: "x64",
      samplerate: "0.1.0",
      chosenLibrary: join(path, ...STORE_SAMPLERATE_LIBRARY.path.split("/")),
      chosenLibrarySha256: STORE_SAMPLERATE_LIBRARY.sha256,
      bindingSha256: STORE_SAMPLERATE_BINDING.sha256,
      inputSamples: 128,
      outputSamples: 256,
      finiteOutput: true,
      packages,
    });
    const value = {
      version: 1,
      purpose: "store-only-x64-python-projection",
      sourceRoot: source,
      outputRoot: projection,
      sourceSelectedFiles: 10052,
      omissions: STORE_PYTHON_OMISSIONS,
      outputFiles: 10032,
      outputCensus: {
        file: "python-projection-census.json",
        bytes: 1,
        sha256: "a".repeat(64),
      },
      sourceCensus: {
        file: "python-source-census.json",
        bytes: 1,
        sha256: "a".repeat(64),
      },
      requirementsLockSha256: createHash("sha256")
        .update(requirements)
        .digest("hex"),
      sourceSamplerateProbe: probe(source),
      projectionSamplerateProbe: probe(projection),
      defaultConsumerDmlProbesRequired: true,
      legacyCorePreserved: true,
      consumerReady: false,
      storeExecutionQualified: false,
      licenseApproval: "pending",
    };
    expect(
      parseStorePythonProjectionReceipt(encode(value), projection, requirements)
        .outputFiles,
    ).toBe(10032);
    expect(
      parseStorePythonProjectionReceipt(encode(value), projection, requirements)
        .pythonDistributionProfile,
    ).toBeUndefined();
    for (const changed of [
      { ...value, pythonDistributionProfile: "store-kim-mdx-v1" },
      { ...value, consumerReady: true },
      { ...value, defaultConsumerDmlProbesRequired: false },
      { ...value, sourceRoot: projection },
      { ...value, outputFiles: 10052 },
      { ...value, omissions: [] },
      {
        ...value,
        projectionSamplerateProbe: {
          ...probe(projection),
          chosenLibrary: join(root, "outside.dll"),
        },
      },
      {
        ...value,
        sourceSamplerateProbe: {
          ...probe(source),
          packages: { ...packages, onnxruntime: "1" },
        },
      },
      {
        ...value,
        sourceCensus: { ...value.sourceCensus, file: "foreign.json" },
      },
    ])
      expect(() =>
        parseStorePythonProjectionReceipt(
          encode(changed),
          projection,
          requirements,
        ),
      ).toThrow();
    expect(() =>
      parseStorePythonProjectionReceipt(
        Buffer.from(
          encode(value)
            .toString()
            .replace('"version":1', '"version":1,"version":1'),
        ),
        projection,
        requirements,
      ),
    ).toThrow();
  });
  it("omits only exact observed auxiliary identities and rejects foreign or changed PE claims", () => {
    expect(STORE_PYTHON_OMISSIONS).toHaveLength(20);
    for (const known of STORE_PYTHON_OMISSIONS) {
      const { reason: _, ...identity } = known;
      expect(assertStorePythonOmission(identity).path).toBe(known.path);
      for (const changed of [
        { ...identity, path: "Lib/foreign.dll" },
        { ...identity, sha256: "f".repeat(64) },
        { ...identity, bytes: identity.bytes + 1 },
        { ...identity, machine: 0 },
        { ...identity, optionalMagic: 0 },
        { ...identity, skipAudit: true },
      ])
        expect(() => assertStorePythonOmission(changed)).toThrow();
    }
    const first = STORE_PYTHON_OMISSIONS[0]!,
      value = {
        path: first.path,
        bytes: first.bytes,
        sha256: first.sha256,
        machine: first.machine,
        optionalMagic: first.optionalMagic,
      };
    let called = false;
    Object.defineProperty(value, "sha256", {
      enumerable: true,
      get() {
        called = true;
        return first.sha256;
      },
    });
    expect(() => assertStorePythonOmission(value)).toThrow();
    expect(called).toBe(false);
  });
  it("copies a complete census row by its byte/hash identity and never overwrites an existing output", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "store-pinned-copy-")),
    );
    try {
      const bytes = Buffer.from("actual isolated cache leaf"),
        source = join(root, "source.js"),
        destination = join(root, "new-cache/source.js"),
        row = {
          path: "source.js",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      await writeFile(source, bytes, { flag: "wx" });
      await copyStorePinnedFile(source, destination, row);
      expect(await readFile(destination)).toEqual(bytes);
      await expect(
        copyStorePinnedFile(source, destination, row),
      ).rejects.toThrow();
      await expect(
        copyStorePinnedFile(source, join(root, "changed.js"), {
          ...row,
          sha256: "a".repeat(64),
        }),
      ).rejects.toThrow("STORE_WORKER_INPUT_CHANGED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("receives full on-disk code inventories beyond the ordinary wire node budget", () => {
    const leaves = Array.from({ length: 10052 }, (_, index) => ({
      path: `code/${String(index).padStart(5, "0")}.py`,
      bytes: 0,
      sha256: empty,
    }));
    expect(parseStoreBuildDocument(encode(leaves))).toEqual(leaves);
  });
  it("retains decoded-key, finite-number, grammar, depth and fixed node limits in large build documents", () => {
    for (const bytes of [
      Buffer.from('{"path":1,"\\u0070ath":2}'),
      Buffer.from('{"bytes":1e400}'),
      Buffer.from("[01]"),
      Buffer.from("[true,]"),
      Buffer.from('"unterminated'),
      Buffer.from("[".repeat(33) + "0" + "]".repeat(33)),
      Buffer.from("[" + "0,".repeat(400000) + "0]"),
      Buffer.from([0xff]),
      Buffer.alloc(8 * 1024 ** 2 + 1, 32),
    ])
      expect(() => parseStoreBuildDocument(bytes)).toThrow();
    expect(() => parseStoreBuildDocument(Buffer.from("null"), 3)).toThrow();
    expect(() =>
      parseStoreBuildDocument(Buffer.from("null"), 8 * 1024 ** 2 + 1),
    ).toThrow();
  });
  it("receives a deep-frozen exact role/pin set while retaining non-installable purpose", () => {
    const parsed = parseStoreWorkerBuildInputsBytes(encode(inputs()));
    expect(parsed.purpose).toBe("unsigned-store-worker-directory");
    expect(parsed.nativeBuild.executables.map((row) => row.path)).toEqual(
      STORE_NATIVE_ROLE_FILES.worker,
    );
    expect(Object.isFrozen(parsed.acquisition)).toBe(true);
  });
  it("rejects caller skips, alternate roles, relative roots and moved proof files", () => {
    const value = inputs();
    for (const changed of [
      { ...value, skipValidation: true },
      { ...value, purpose: "windows-user-release" },
      { ...value, nodeRoot: "./node" },
      { ...value, appBuildNumber: 0 },
      {
        ...value,
        nativeBuild: {
          ...value.nativeBuild,
          executables: STORE_NATIVE_ROLE_FILES.gui.map(pin),
        },
      },
      {
        ...value,
        acquisition: {
          ...value.acquisition,
          cachePins: pin(join(root, "foreign-cache.json")),
        },
      },
    ])
      expect(() => parseStoreWorkerBuildInputs(changed)).toThrow();
  });
  it("rejects receiving accessors, duplicate JSON fields and malformed UTF8 without invoking a getter", () => {
    const value = inputs();
    let called = false;
    Object.defineProperty(value, "pythonRoot", {
      enumerable: true,
      get() {
        called = true;
        return "fixture";
      },
    });
    expect(() => parseStoreWorkerBuildInputs(value)).toThrow();
    expect(called).toBe(false);
    for (const bytes of [
      Buffer.from("\xff", "binary"),
      Buffer.from(
        encode(inputs())
          .toString()
          .replace('"version":1', '"version":1,"version":1'),
      ),
      Buffer.alloc(16385, 32),
    ])
      expect(() => parseStoreWorkerBuildInputsBytes(bytes)).toThrow();
  });
  it("keeps zero-size leaves real and rejects native-empty, aliases, reordered/case duplicate pins", () => {
    const rows = [
      { path: "a/.lock", bytes: 0, sha256: empty },
      { path: "b/code.js", bytes: 1, sha256: "a".repeat(64) },
    ];
    expect(parseStoreAcquisitionPins(encode(rows))[0]!.bytes).toBe(0);
    for (const bad of [
      [...rows].reverse(),
      [rows[0], rows[0]],
      rows.map((row, index) =>
        index ? row : { ...row, sha256: "0".repeat(64) },
      ),
      rows.map((row, index) => (index ? row : { ...row, path: "a/empty.exe" })),
      rows.map((row, index) => (index ? row : { ...row, path: "../foreign" })),
      [
        { path: "Code.js", bytes: 1, sha256: "a".repeat(64) },
        { path: "code.js", bytes: 1, sha256: "a".repeat(64) },
      ],
    ])
      expect(() => parseStoreAcquisitionPins(encode(bad))).toThrow();
  });
  it("admits only the unchanged exact Windows Deno/provider/lock/configuration with a full cache inventory", () => {
    const value = youtube(),
      parsed = parseStoreYoutubeIdentity(encode(value));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.some((row) => row.path.startsWith("deno-cache/"))).toBe(true);
    for (const changed of [
      { ...value, arch: "arm64" },
      { ...value, extra: true },
      {
        ...value,
        files: value.files.filter((row) => !row.path.startsWith("deno-cache/")),
      },
      { ...value, files: [...value.files].reverse() },
      {
        ...value,
        files: value.files.map((row) =>
          row.path === "provider/deno.lock"
            ? { ...row, sha256: "f".repeat(64) }
            : row,
        ),
      },
      {
        ...value,
        files: value.files.map((row) =>
          row.path === "bin/deno.exe" ? { ...row, bytes: 1 } : row,
        ),
      },
    ])
      expect(() => parseStoreYoutubeIdentity(encode(changed))).toThrow();
  });
  it("pins the qualified production-derived lock and rejects the pre-install base lock", () => {
    const value = youtube();
    const withLock = (bytes: number, sha256: string) => ({
      ...value,
      files: value.files.map((row) =>
        row.path === "provider/deno.lock" ? { ...row, bytes, sha256 } : row,
      ),
    });
    const qualified = withLock(
      38554,
      "c5df5d573e01674589e6ef8f7f23d86a855e071fa1324660f0a4fb43284d4b62",
    );
    expect(parseStoreYoutubeIdentity(encode(qualified))).toContainEqual({
      path: "provider/deno.lock",
      bytes: 38554,
      sha256:
        "c5df5d573e01674589e6ef8f7f23d86a855e071fa1324660f0a4fb43284d4b62",
    });
    for (const rejected of [
      withLock(
        81012,
        "d66aa7e0ce8ca8023eb3408ba4bd8af6c51888faa5ccca41b0490d71b702edaa",
      ),
      withLock(38554, "f".repeat(64)),
    ])
      expect(() => parseStoreYoutubeIdentity(encode(rejected))).toThrow(
        "STORE_ACQUISITION_INVALID",
      );
  });
  it("denies development/private/media/foreign executable code in an otherwise complete provider inventory", () => {
    for (const path of [
      "provider/tests/code.js",
      "private/token.json",
      "provider/node_modules/.bin/foreign.exe",
      "provider/.env",
      "provider/song.mp3",
      "provider/a:stream",
    ]) {
      const value = youtube();
      value.files.push({ path, bytes: 1, sha256: "a".repeat(64) });
      value.files.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      expect(() => parseStoreYoutubeIdentity(encode(value))).toThrow();
    }
  });
  it("pins the actual official build-side pnpm archive and cannot accept a metadata-only substitute", async () => {
    expect(STORE_PNPM_TOOL.version).toBe("10.14.0");
    expect(STORE_PNPM_TOOL.files).toBe(1111);
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("placeholder"),
      Buffer.alloc(STORE_PNPM_TOOL.bytes),
    ])
      await expect(storePnpmArchiveFiles(bytes, component)).rejects.toThrow(
        "STORE_PNPM_TOOL_INVALID",
      );
  });
  it("uses fixed offline/frozen/no-script/copy/hoisted semantics and fresh private config without ambient Node or credentials", () => {
    const args = storePnpmInstallArguments("fixed/pnpm.cjs", "fixed/store");
    for (const expected of [
      "--offline",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--config.package-import-method=copy",
      "--config.node-linker=hoisted",
      "--config.verify-store-integrity=true",
    ])
      expect(args).toContain(expected);
    const env = storePnpmEnvironment(root);
    expect(env.NPM_CONFIG_USERCONFIG).toBe(join(root, "user.npmrc"));
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows");
    expect(Object.keys(env)).not.toContain("NODE_OPTIONS");
    expect(Object.keys(env)).not.toContain("npm_execpath");
    expect(Object.keys(env)).not.toContain("NPM_TOKEN");
    const fetch = storePnpmFetchArguments("fixed/pnpm.cjs", "fixed/store");
    expect(fetch).toContain("--config.registry=https://registry.npmjs.org/");
    expect(fetch).toContain("--ignore-scripts");
    expect(fetch).toContain("--prod");
    expect(fetch).toContain("--config.fetch-retries=0");
    expect(fetch).not.toContain("install");
  });
  it("cannot turn Mac/source fixtures into a Windows runtime assembly", async () => {
    if (process.platform !== "win32")
      await expect(
        buildStoreWorkerDirectory(inputs(), component, join(root, "candidate")),
      ).rejects.toThrow("STORE_WORKER_WINDOWS_REQUIRED");
    if (process.platform !== "win32")
      await expect(
        createStorePythonProjection(
          root,
          join(root, "projection"),
          join(root, "work"),
          Buffer.from("fixture"),
        ),
      ).rejects.toThrow("STORE_WORKER_WINDOWS_REQUIRED");
    if (process.platform !== "win32")
      await expect(
        prepareStoreProductionDependencyCache({
          workerRoot: root,
          componentRoot: component,
          nodeRoot: root,
          toolRoot: root,
          storeRoot: root,
          workRoot: root,
        }),
      ).rejects.toThrow("STORE_WORKER_WINDOWS_REQUIRED");
  });
});
