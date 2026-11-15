import { createHash, generateKeyPairSync } from "node:crypto";
import {
  mkdir,
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditConsumerTree,
  buildWindowsConsumerPackage,
  createWindowsConsumerArchive,
  parsePackageLock,
  STORE_KIM_MDX_PYTHON_PROFILE,
  STORE_KIM_MDX_SOURCE_LOCK_SHA256,
  windowsConsumerPackagesForProfile,
  signWindowsConsumerArtifact,
  verifyWindowsConsumerAcquisition,
  verifyPinnedAcquisitionInventory,
  WINDOWS_CONSUMER_PINS,
  type WindowsConsumerPackageOptions,
  type WindowsConsumerRuntimeProbe,
} from "../src/platform/windows/consumer-package.js";
import { verifyWindowsRelease } from "../src/platform/windows/release-manifest.js";
import { fixturePe64 } from "./fixtures/windows-pe64.js";
import {
  verifyUpdateMetadata,
  type UpdateMetadata,
} from "../src/platform/shared/update-metadata.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const probe: WindowsConsumerRuntimeProbe = {
  nativeArchitecture: "x64",
  node: "24.18.0",
  python: "3.12.10",
  onnxRuntime: "1.24.4",
  audioSeparator: "0.47.0",
  ffmpeg: "8.0.3",
  deno: "2.9.7",
  packages: { "audio-separator": "0.47.0", "onnxruntime-directml": "1.24.4" },
};
const fixtureChecks = () => ({
  host: { platform: "win32" as const, arch: "x64" },
  probe: vi.fn(async () => structuredClone(probe)),
  acquisition: vi.fn(async () => {}),
  productionDependencies: vi.fn(async () => {}),
});

describe("Windows consumer package code fixtures (not native release proof)", () => {
  it("keeps the full source lock while explicitly binding only the Store MDX product to its exact 62 distributions", async () => {
    const lock = await readFile(
        new URL(
          "../../tools/worker-gpu-feasibility/requirements-directml.lock.txt",
          import.meta.url,
        ),
        "utf8",
      ),
      full = windowsConsumerPackagesForProfile(lock),
      retained = windowsConsumerPackagesForProfile(
        lock,
        STORE_KIM_MDX_PYTHON_PROFILE,
      );
    expect(createHash("sha256").update(lock).digest("hex")).toBe(
      STORE_KIM_MDX_SOURCE_LOCK_SHA256,
    );
    expect(Object.keys(full)).toHaveLength(63);
    expect(Object.keys(retained)).toHaveLength(62);
    expect(full["diffq-fixed"]).toBe("0.2.4");
    expect(retained["diffq-fixed"]).toBeUndefined();
    expect({ ...retained, "diffq-fixed": "0.2.4" }).toEqual(full);
    for (const changed of [
      lock.replace("diffq-fixed==0.2.4\n", ""),
      lock.replace("diffq-fixed==0.2.4", "diffq-fixed==0.2.5"),
      lock.replace("numpy==2.5.3", "numpy==2.5.2"),
      lock + "unknown-distribution==1\n",
    ])
      expect(() =>
        windowsConsumerPackagesForProfile(
          changed,
          STORE_KIM_MDX_PYTHON_PROFILE,
        ),
      ).toThrow("exact full source lock");
    expect(() =>
      windowsConsumerPackagesForProfile(
        lock,
        "foreign" as typeof STORE_KIM_MDX_PYTHON_PROFILE,
      ),
    ).toThrow();
  });
  it("requires exact reduced source and relocated census only for the explicit Store profile, preserving legacy complete-lock denial", async () => {
    const lock = await readFile(
        new URL(
          "../../tools/worker-gpu-feasibility/requirements-directml.lock.txt",
          import.meta.url,
        ),
        "utf8",
      ),
      packages = windowsConsumerPackagesForProfile(
        lock,
        STORE_KIM_MDX_PYTHON_PROFILE,
      ),
      options = {
        ...(await inputs()),
        pythonDistributionProfile: STORE_KIM_MDX_PYTHON_PROFILE,
      },
      observedProfiles: (typeof STORE_KIM_MDX_PYTHON_PROFILE | undefined)[] =
        [],
      checks = {
        ...fixtureChecks(),
        probe: vi.fn(async (observed: WindowsConsumerPackageOptions) => {
          observedProfiles.push(observed.pythonDistributionProfile);
          return { ...probe, packages: { ...packages } };
        }),
      };
    await writeFile(options.requirementsLockPath, lock);
    await buildWindowsConsumerPackage(options, checks);
    expect(observedProfiles).toEqual([
      STORE_KIM_MDX_PYTHON_PROFILE,
      STORE_KIM_MDX_PYTHON_PROFILE,
    ]);
    const manifest = JSON.parse(
      await readFile(
        join(options.outputRoot, "runtime/consumer-source-manifest.json"),
        "utf8",
      ),
    );
    expect(manifest.pythonDistributionProfile).toBe(
      STORE_KIM_MDX_PYTHON_PROFILE,
    );
    expect(manifest.pythonDependencyClosure).toBe(
      "product-specific-not-full-upstream",
    );
    expect(manifest.omittedDistributions).toEqual({ "diffq-fixed": "0.2.4" });
    expect(manifest.sourcePackages).toEqual(parsePackageLock(lock));
    expect(manifest.observed.packages).toEqual(packages);
    expect(
      await readFile(
        join(options.outputRoot, "runtime/requirements-directml.lock.txt"),
        "utf8",
      ),
    ).toBe(lock);
    const legacy = await inputs();
    await writeFile(legacy.requirementsLockPath, lock);
    await expect(buildWindowsConsumerPackage(legacy, checks)).rejects.toThrow(
      "not pinned: diffq-fixed",
    );
    for (const changed of [
      { ...packages, "diffq-fixed": "0.2.4" },
      { ...packages, numpy: "modified" },
      { ...packages, unknown: "1" },
      Object.fromEntries(
        Object.entries(packages).filter(([name]) => name !== "numpy"),
      ),
    ]) {
      const bad = {
        ...(await inputs()),
        pythonDistributionProfile: STORE_KIM_MDX_PYTHON_PROFILE,
      };
      await writeFile(bad.requirementsLockPath, lock);
      await expect(
        buildWindowsConsumerPackage(bad, {
          ...fixtureChecks(),
          probe: async () => ({ ...probe, packages: changed }),
        }),
      ).rejects.toThrow();
    }
    const relocated = {
        ...(await inputs()),
        pythonDistributionProfile: STORE_KIM_MDX_PYTHON_PROFILE,
      },
      relocatedChecks = fixtureChecks();
    await writeFile(relocated.requirementsLockPath, lock);
    relocatedChecks.probe = vi
      .fn()
      .mockResolvedValueOnce({ ...probe, packages })
      .mockResolvedValueOnce({
        ...probe,
        packages: { ...packages, "diffq-fixed": "0.2.4" },
      });
    await expect(
      buildWindowsConsumerPackage(relocated, relocatedChecks),
    ).rejects.toThrow("exact Store MDX product census");
    await expect(lstat(relocated.outputRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("missing delayed VC imports fail before relocated probe/inventory publication even when a source probe returned pinned versions", async () => {
    const options = await inputs(),
      checks = fixtureChecks();
    await writeFile(
      join(options.pythonRoot, "python.exe"),
      fixturePe64([{ name: "vcruntime140.dll", kind: "delay" }]),
    );
    await expect(buildWindowsConsumerPackage(options, checks)).rejects.toThrow(
      "missing or ambiguous",
    );
    expect(checks.probe).toHaveBeenCalledOnce();
    await expect(lstat(options.outputRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("captures hash-bound structural DLL/notice evidence in the signed consumer inventory without claiming a real redistributable", async () => {
    const options = await inputs(),
      checks = fixtureChecks(),
      dll = fixturePe64(),
      license = Buffer.from("Synthetic redistribution notice fixture only");
    await writeFile(
      join(options.pythonRoot, "python.exe"),
      fixturePe64([{ name: "vcruntime140.dll", kind: "import" }]),
    );
    await writeFile(join(options.pythonRoot, "vcruntime140.dll"), dll);
    await mkdir(join(options.pythonRoot, "licenses", "msvc"), {
      recursive: true,
    });
    await writeFile(
      join(options.pythonRoot, "licenses", "msvc", "LICENSE.txt"),
      license,
    );
    await writeFile(
      join(options.pythonRoot, "redistributables.json"),
      JSON.stringify({
        schemaVersion: 1,
        architecture: "x64",
        sourceUrl: "https://aka.ms/vs/17/release/vc_redist.x64.exe",
        version: "14.44.35211",
        license: {
          path: "runtime/python/licenses/msvc/LICENSE.txt",
          bytes: license.length,
          sha256: createHash("sha256").update(license).digest("hex"),
        },
        files: [
          {
            path: "runtime/python/vcruntime140.dll",
            bytes: dll.length,
            sha256: createHash("sha256").update(dll).digest("hex"),
          },
        ],
      }),
    );
    const manifest = await buildWindowsConsumerPackage(options, checks),
      source = JSON.parse(
        await readFile(
          join(options.outputRoot, "runtime", "consumer-source-manifest.json"),
          "utf8",
        ),
      );
    expect(source.dllAudit.msvc.version).toBe("14.44.35211");
    expect(source.dllAudit.imports).toContainEqual({
      binary: "runtime/python/python.exe",
      name: "vcruntime140.dll",
      kind: "import",
      source: "private",
      path: "runtime/python/vcruntime140.dll",
    });
    expect(
      manifest.entries.some(
        (entry) => entry.path === "runtime/python/licenses/msvc/LICENSE.txt",
      ),
    ).toBe(true);
    expect(checks.probe).toHaveBeenCalledTimes(2);
  });
  it("rejects a consumer runtime missing the actual fixed independent login entry", async () => {
    const options = await inputs();
    await rm(join(options.agentRoot, "login-worker.cjs"));
    await expect(
      buildWindowsConsumerPackage(options, fixtureChecks()),
    ).rejects.toThrow("agent/login-worker.cjs");
    await expect(lstat(options.outputRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("verifies acquisition byte inventories and rejects extra, changed and linked files", async () => {
    const root = await temporary(),
      data = Buffer.from("synthetic pinned acquisition file");
    const path = join(root, "entry.js");
    await writeFile(path, data);
    await writeFile(join(root, "identity.json"), "{}");
    const inventory = new Map([
      [
        "entry.js",
        {
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        },
      ],
    ]);
    await expect(
      verifyPinnedAcquisitionInventory(root, inventory),
    ).resolves.toBeUndefined();
    await writeFile(path, Buffer.alloc(data.length));
    await expect(
      verifyPinnedAcquisitionInventory(root, inventory),
    ).rejects.toThrow("digest differs");
    await writeFile(path, data);
    await writeFile(join(root, "extra.js"), "extra");
    await expect(
      verifyPinnedAcquisitionInventory(root, inventory),
    ).rejects.toThrow("does not cover");
    await rm(join(root, "extra.js"));
    await symlink("entry.js", join(root, "linked.js"));
    await expect(
      verifyPinnedAcquisitionInventory(root, inventory),
    ).rejects.toThrow("link or reparse");
  });
  it("keeps independent empty Deno/package leaves with the exact empty SHA and complete census", async () => {
    const root = await temporary(),
      emptySha = createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      name = ".deno/.deno.lock",
      path = join(root, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(0));
    await writeFile(join(root, "identity.json"), "{}");
    const inventory = new Map([[name, { bytes: 0, sha256: emptySha }]]);
    await expect(
      verifyPinnedAcquisitionInventory(root, inventory),
    ).resolves.toBeUndefined();
    expect((await lstat(path)).size).toBe(0);
    expect((await lstat(path)).nlink).toBe(1);
    await expect(
      verifyPinnedAcquisitionInventory(
        root,
        new Map([[name, { bytes: 0, sha256: "a".repeat(64) }]]),
      ),
    ).rejects.toThrow("digest is invalid");
    await writeFile(path, "changed");
    await expect(
      verifyPinnedAcquisitionInventory(root, inventory),
    ).rejects.toThrow("digest differs");
    await writeFile(path, Buffer.alloc(0));
    await writeFile(join(root, "extra-empty.js"), Buffer.alloc(0));
    await expect(
      verifyPinnedAcquisitionInventory(root, inventory),
    ).rejects.toThrow("does not cover");
    await rm(join(root, "extra-empty.js"));
    const other = await temporary();
    await link(path, join(other, "same-empty"));
    await expect(
      verifyPinnedAcquisitionInventory(root, inventory),
    ).rejects.toThrow("unsafe entry");
  });
  it.each(["bin/deno.exe", "canvas.dll", "canvas.node", "module.pyd"])(
    "rejects an empty native executable role %s even with the genuine empty SHA",
    async (name) => {
      const root = await temporary(),
        emptySha = createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
        path = join(root, ...name.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(0));
      await writeFile(join(root, "identity.json"), "{}");
      await expect(
        verifyPinnedAcquisitionInventory(
          root,
          new Map([[name, { bytes: 0, sha256: emptySha }]]),
        ),
      ).rejects.toThrow("digest is invalid");
    },
  );
  it("assembles only the per-user shape and audits real fixture PE headers", async () => {
    const options = await inputs(),
      checks = fixtureChecks();
    const manifest = await buildWindowsConsumerPackage(options, checks);
    expect(
      await verifyWindowsRelease(options.outputRoot, "windows-user"),
    ).toEqual(manifest);
    expect(checks.probe).toHaveBeenCalledTimes(2); // Original and relocated closure.
    const files = manifest.entries.map((entry) => entry.path);
    expect(files).toContain("runtime/native/musicmute-native.exe");
    expect(files).toContain("agent/session-agent.cjs");
    expect(files).toContain("agent/login-worker.cjs");
    expect(files).toContain("tools/downloader/downloader_bootstrap.py");
    expect(files).toContain("tools/youtube/bin/deno.exe");
    expect(
      files.some((path) => /WinSW|runtime\/service|installer\//u.test(path)),
    ).toBe(false);
    expect(files).not.toContain("app/dist/source.js.map");
    const provenance = JSON.parse(
      await readFile(
        join(options.outputRoot, "runtime", "consumer-source-manifest.json"),
        "utf8",
      ),
    );
    expect(provenance.installationProfile).toBe("windows-user");
    expect(provenance.requirementsLockSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(provenance)).not.toContain(options.workerRoot);
  });

  it("omits only the four vendor example/macOS leaves from the Python copy while preserving its Windows DLL and sources", async () => {
    const options = await inputs(),
      checks = fixtureChecks(),
      nonRuntimeLeaves = [
        "Lib/site-packages/onnxruntime/datasets/logreg_iris.onnx",
        "Lib/site-packages/onnxruntime/datasets/mul_1.onnx",
        "Lib/site-packages/onnxruntime/datasets/sigmoid.onnx",
        "Lib/site-packages/samplerate/_samplerate_data/libsamplerate.dylib",
      ],
      windowsLibrary =
        "Lib/site-packages/samplerate/_samplerate_data/libsamplerate-64bit.dll";
    for (const name of [...nonRuntimeLeaves, windowsLibrary]) {
      const path = join(options.pythonRoot, ...name.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, name === windowsLibrary ? pe() : "vendor fixture");
    }
    const manifest = await buildWindowsConsumerPackage(options, checks),
      paths = manifest.entries.map((entry) => entry.path);
    for (const name of nonRuntimeLeaves) {
      expect(paths).not.toContain(`runtime/python/${name}`);
      expect(
        await readFile(join(options.pythonRoot, ...name.split("/")), "utf8"),
      ).toBe("vendor fixture");
    }
    expect(paths).toContain(`runtime/python/${windowsLibrary}`);
    expect(checks.probe).toHaveBeenCalledTimes(2);
    expect(checks.probe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        pythonRoot: expect.stringContaining(join("runtime", "python")),
      }),
    );
    expect(
      await readFile(
        join(
          options.outputRoot,
          "runtime",
          "python",
          ...windowsLibrary.split("/"),
        ),
      ),
    ).toEqual(pe());
  });

  it.each([
    "Lib/site-packages/onnxruntime/datasets/private-model.onnx",
    "Lib/site-packages/other/datasets/logreg_iris.onnx",
    "Lib/site-packages/samplerate/_samplerate_data/other.dylib",
    "Lib/site-packages/ONNXRuntime/datasets/logreg_iris.onnx",
    "Lib/site-packages/samplerate/_samplerate_data/credentials.json",
    "Lib/site-packages/WinSW/worker.exe",
  ])(
    "keeps the receiving denial for unknown Python payload %s",
    async (name) => {
      const options = await inputs(),
        checks = fixtureChecks(),
        path = join(options.pythonRoot, ...name.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "unsupported fixture");
      await expect(
        buildWindowsConsumerPackage(options, checks),
      ).rejects.toThrow("private, service or unsupported payload");
      expect(checks.probe).toHaveBeenCalledOnce();
      await expect(lstat(options.outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("omits only the unavailable optional TBB pool while retaining Numba's OpenMP and workqueue binaries", async () => {
    const options = await inputs(),
      checks = fixtureChecks(),
      pool = "Lib/site-packages/numba/np/ufunc/",
      tbb = `${pool}tbbpool.cp312-win_amd64.pyd`,
      retained = [
        `${pool}omppool.cp312-win_amd64.pyd`,
        `${pool}workqueue.cp312-win_amd64.pyd`,
        `${pool}tbbpool.cp313-win_amd64.pyd`,
      ],
      original = pe();
    for (const name of [tbb, ...retained]) {
      const path = join(options.pythonRoot, ...name.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, original);
    }
    const manifest = await buildWindowsConsumerPackage(options, checks),
      paths = manifest.entries.map((entry) => entry.path);
    expect(paths).not.toContain(`runtime/python/${tbb}`);
    for (const name of retained) {
      expect(paths).toContain(`runtime/python/${name}`);
      expect(
        await readFile(
          join(options.outputRoot, "runtime/python", ...name.split("/")),
        ),
      ).toEqual(original);
    }
    expect(await readFile(join(options.pythonRoot, ...tbb.split("/")))).toEqual(
      original,
    );
    expect(checks.probe).toHaveBeenCalledTimes(2);
  });

  it.each([
    "Lib/site-packages/onnxruntime/datasets/logreg_iris.onnx",
    "Lib/site-packages/onnxruntime/datasets/mul_1.onnx",
    "Lib/site-packages/onnxruntime/datasets/sigmoid.onnx",
    "Lib/site-packages/samplerate/_samplerate_data/libsamplerate.dylib",
  ])(
    "still rejects %s when directly presented to the receiving audit",
    async (name) => {
      const root = await temporary(),
        path = join(root, "runtime", "python", ...name.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "unsupported fixture");
      await expect(auditConsumerTree(root)).rejects.toThrow(
        "private, service or unsupported payload",
      );
    },
  );

  it("rejects host, version, distribution and relocatability mismatches before publishing a tree", async () => {
    const options = await inputs();
    await expect(
      buildWindowsConsumerPackage(options, {
        ...fixtureChecks(),
        host: { platform: "darwin", arch: "arm64" },
      }),
    ).rejects.toThrow("native Windows x64");
    await expect(
      buildWindowsConsumerPackage(
        { ...options, releaseVersion: "0.1.99" },
        fixtureChecks(),
      ),
    ).rejects.toThrow("versions differ");
    await expect(
      buildWindowsConsumerPackage(options, {
        ...fixtureChecks(),
        probe: async () => ({ ...probe, python: "3.13.7" }),
      }),
    ).rejects.toThrow("pinned versions");
    await expect(
      buildWindowsConsumerPackage(options, {
        ...fixtureChecks(),
        probe: async () => ({
          ...probe,
          packages: { ...probe.packages, onnxruntime: "1.24.4" },
        }),
      }),
    ).rejects.toThrow("inventory differs");
    await writeFile(
      join(options.pythonRoot, "pyvenv.cfg"),
      "home = C:\\private-build-python",
    );
    await expect(
      buildWindowsConsumerPackage(options, fixtureChecks()),
    ).rejects.toThrow("not a virtual environment");
    await expect(
      readFile(join(options.outputRoot, "release-manifest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails a bad native binary, source link and private material without leaving completed output", async () => {
    const options = await inputs();
    await writeFile(options.nativeBinary, pe(0xaa64));
    await expect(
      buildWindowsConsumerPackage(options, fixtureChecks()),
    ).rejects.toThrow("not x86_64");
    await writeFile(options.nativeBinary, pe());
    await symlink("fleet.cjs", join(options.agentRoot, "unexpected-link"));
    await expect(
      buildWindowsConsumerPackage(options, fixtureChecks()),
    ).rejects.toThrow("link or reparse");
    await rm(join(options.agentRoot, "unexpected-link"));
    await writeFile(
      join(options.agentRoot, "credentials.json"),
      '{"credential":"private"}',
    );
    await expect(
      buildWindowsConsumerPackage(options, fixtureChecks()),
    ).rejects.toThrow("private, service");
  });

  it("audit rejects private keys, service binaries and hidden model payloads but permits public CA bundles", async () => {
    const root = await temporary(),
      runtime = join(root, "runtime");
    await mkdir(runtime);
    const file = join(runtime, "tls.pem");
    await writeFile(
      file,
      "-----BEGIN CERTIFICATE-----\npublic CA\n-----END CERTIFICATE-----",
    );
    await expect(auditConsumerTree(root)).resolves.toBeUndefined();
    await writeFile(
      file,
      "-----BEGIN PRIVATE KEY-----\nprivate fixture\n-----END PRIVATE KEY-----",
    );
    await expect(auditConsumerTree(root)).rejects.toThrow(
      "credential material",
    );
    await rm(file);
    await writeFile(join(runtime, "Kim_Vocal_2.onnx"), "fixture model");
    await expect(auditConsumerTree(root)).rejects.toThrow("private, service");
  });

  it.each([
    ["standalone", "", ""],
    ["JSON value", '{"accessKey":"', '"}'],
    ["configuration assignment", "AWS_ACCESS_KEY_ID=", "\n"],
    ["URL query", "https://example.test/?key=", "&end=true"],
    ["underscore-delimited", "_", "_"],
    ["punctuation-delimited", "(", ")"],
    ["line-delimited", "\n", "\r\n"],
  ])("denies complete AWS key tokens in %s", async (_label, before, after) => {
    const root = await temporary(),
      runtime = join(root, "runtime"),
      accessKey = "AKIA" + "A".repeat(16);
    await mkdir(runtime);
    await writeFile(
      join(runtime, "configuration.txt"),
      before + accessKey + after,
    );
    await expect(auditConsumerTree(root)).rejects.toThrow(
      "credential material",
    );
  });

  it.each([
    ["longer encoded word", "a", "B"],
    ["alphanumeric prefix", "A", ""],
    ["alphanumeric suffix", "", "0"],
  ])(
    "ignores an AWS-shaped substring inside a %s without exempting adjacent credentials",
    async (_label, before, after) => {
      const root = await temporary(),
        runtime = join(root, "runtime"),
        accessKey = "AKIA" + "A".repeat(16),
        encoded = before + accessKey + after;
      await mkdir(runtime);
      const file = join(runtime, "asset.py");
      await writeFile(file, `encoded = "${encoded}"\n`);
      await expect(auditConsumerTree(root)).resolves.toBeUndefined();
      for (const credential of [
        `key = "${accessKey}"`,
        'key = "-----BEGIN PRIVATE KEY-----"',
        'uri = "mongodb://private-host/database"',
      ]) {
        await writeFile(file, `encoded = "${encoded}"\n${credential}\n`);
        await expect(auditConsumerTree(root)).rejects.toThrow(
          "credential material",
        );
      }
    },
  );

  it.each(["js", "cjs", "mjs"])(
    "permits complete identifier-only Mongo URI source templates in %s without exempting the file",
    async (extension) => {
      const root = await temporary(),
        runtime = join(root, "runtime");
      await mkdir(runtime);
      const file = join(runtime, `source.${extension}`);
      await writeFile(
        file,
        "const attributes = { connection: `mongodb://${host}:${port}/${dbName}`, other: `mongodb+srv://${server}:${servicePort}/${database}` };",
      );
      await expect(auditConsumerTree(root)).resolves.toBeUndefined();
      await writeFile(
        file,
        'const uri = `mongodb://${host}:${port}/${dbName}`; const key = "' +
          "AKIA" +
          "A".repeat(16) +
          '";',
      );
      await expect(auditConsumerTree(root)).rejects.toThrow(
        "credential material",
      );
      await writeFile(
        file,
        'const uri = `mongodb://${host}:${port}/${dbName}`; const key = "-----BEGIN PRIVATE KEY-----";',
      );
      await expect(auditConsumerTree(root)).rejects.toThrow(
        "credential material",
      );
    },
  );

  it.each([
    ["static URI", "js", 'const uri = "mongodb://private-host/database";'],
    [
      "static SRV URI",
      "js",
      'const uri = "mongodb+srv://private-host/database";',
    ],
    [
      "literal credentials",
      "js",
      "const uri = `mongodb://user:password@${host}:${port}/${dbName}`;",
    ],
    [
      "dynamic userinfo",
      "js",
      "const uri = `mongodb://${user}:${password}@${host}:${port}/${dbName}`;",
    ],
    [
      "literal host",
      "js",
      "const uri = `mongodb://private-host:${port}/${dbName}`;",
    ],
    ["literal port", "js", "const uri = `mongodb://${host}:27017/${dbName}`;"],
    [
      "literal database",
      "js",
      "const uri = `mongodb://${host}:${port}/database`;",
    ],
    [
      "property expression",
      "js",
      "const uri = `mongodb://${config.host}:${port}/${dbName}`;",
    ],
    [
      "call expression",
      "js",
      "const uri = `mongodb://${getHost()}:${port}/${dbName}`;",
    ],
    [
      "extra query",
      "js",
      "const uri = `mongodb://${host}:${port}/${dbName}?token=${token}`;",
    ],
    [
      "surrounding template text",
      "js",
      "const uri = `prefix mongodb://${host}:${port}/${dbName}`;",
    ],
    [
      "quoted template text",
      "js",
      'const uri = "`mongodb://${host}:${port}/${dbName}`";',
    ],
    [
      "commented template text",
      "js",
      "// `mongodb://${host}:${port}/${dbName}`",
    ],
    [
      "block-commented template text",
      "js",
      "/* `mongodb://${host}:${port}/${dbName}` */",
    ],
    [
      "embedded configuration",
      "json",
      '{"uri":"mongodb://${host}:${port}/${dbName}"}',
    ],
    [
      "backticks in configuration",
      "json",
      '{"uri":"`mongodb://${host}:${port}/${dbName}`"}',
    ],
    ["non-JavaScript text", "txt", "`mongodb://${host}:${port}/${dbName}`"],
    [
      "safe and unsafe adjacent templates",
      "js",
      "const uris = [`mongodb://${host}:${port}/${dbName}`,`mongodb://private-host/database`];",
    ],
  ])(
    "denies %s while scanning every Mongo URI",
    async (_label, extension, text) => {
      const root = await temporary(),
        runtime = join(root, "runtime");
      await mkdir(runtime);
      await writeFile(join(runtime, `source.${extension}`), text!);
      await expect(auditConsumerTree(root)).rejects.toThrow(
        "credential material",
      );
    },
  );

  it("requires exact transitive pins and rejects unpinned/conflicting ONNX locks", () => {
    expect(
      parsePackageLock(
        "audio-separator==0.47.0\nonnxruntime-directml==1.24.4\n",
      ),
    ).toEqual(probe.packages);
    for (const lock of [
      "audio-separator>=0.47.0\nonnxruntime-directml==1.24.4",
      "audio-separator==0.47.0\nonnxruntime-directml==1.24.4\nonnxruntime==1.24.4",
      "audio-separator==0.47.0\nonnxruntime-directml==1.24.4\nAudio_Separator==0.47.0",
    ])
      expect(() => parsePackageLock(lock)).toThrow();
    for (const key of [
      "nodeArchiveSha256",
      "denoArchiveSha256",
      "canvasArchiveSha256",
    ] as const)
      expect(WINDOWS_CONSUMER_PINS[key]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not accept fake downloader wheel identities or build Windows ZIPs on this Mac", async () => {
    const options = await inputs();
    await expect(
      verifyWindowsConsumerAcquisition(
        options.downloaderRoot,
        options.youtubeRoot,
      ),
    ).rejects.toThrow("Downloader identity target");
    if (process.platform !== "win32")
      await expect(
        createWindowsConsumerArchive(
          options.workerRoot,
          join(options.outputRoot, "runtime.zip"),
        ),
      ).rejects.toThrow("native Windows x64");
  });

  it("signs the exact user profile/archive digest and rejects tampering, legacy adoption, expiry and rollback", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const now = new Date(),
      metadata: UpdateMetadata = {
        schemaVersion: 1,
        installationProfile: "windows-user",
        platform: "windows-amd64",
        sequence: 5,
        releaseVersion: "0.1.3",
        publishedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        release: {
          filename: "musicmute-runtime-windows-x64.zip",
          bytes: 128,
          sha256: "a".repeat(64),
          contentType: "application/zip",
        },
      };
    const signed = signWindowsConsumerArtifact(
      metadata,
      "fixture-key",
      privateKey,
    );
    const options = {
      platform: "windows-amd64" as const,
      installationProfile: "windows-user" as const,
      publicKeys: {
        "fixture-key": publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
      minimumSequence: 5,
      now,
    };
    expect(verifyUpdateMetadata(signed, options)).toEqual(metadata);
    expect(() =>
      verifyUpdateMetadata(signed, {
        platform: options.platform,
        publicKeys: options.publicKeys,
        minimumSequence: options.minimumSequence,
        now: options.now,
      }),
    ).toThrow("installation profile");
    expect(() =>
      verifyUpdateMetadata(
        {
          ...signed,
          metadata: {
            ...metadata,
            release: { ...metadata.release, sha256: "b".repeat(64) },
          },
        },
        options,
      ),
    ).toThrow("signature does not match");
    expect(() =>
      verifyUpdateMetadata(signed, { ...options, minimumSequence: 6 }),
    ).toThrow("rollback");
    expect(() =>
      verifyUpdateMetadata(signed, {
        ...options,
        now: new Date(now.getTime() + 86_400_001),
      }),
    ).toThrow("validity window");
    expect(() =>
      verifyUpdateMetadata(signed, { ...options, publicKeys: {} }),
    ).toThrow("not trusted");
  });
});

function pe(machine = 0x8664): Buffer {
  const value = fixturePe64();
  value.writeUInt16LE(machine, 132);
  return value;
}
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-consumer-fixture-"));
  roots.push(root);
  return root;
}
async function inputs(): Promise<WindowsConsumerPackageOptions> {
  const root = await temporary();
  const options: WindowsConsumerPackageOptions = {
    workerRoot: join(root, "worker"),
    outputRoot: join(root, "release"),
    releaseVersion: "0.1.3",
    nodeRoot: join(root, "node"),
    pythonRoot: join(root, "python"),
    mediaRoot: join(root, "media"),
    nativeBinary: join(root, "native", "musicmute-native.exe"),
    agentRoot: join(root, "agents"),
    downloaderRoot: join(root, "downloader"),
    youtubeRoot: join(root, "youtube"),
    requirementsLockPath: join(root, "requirements.lock.txt"),
  };
  const files: [string, string | Buffer][] = [
    [
      join(options.workerRoot, "package.json"),
      JSON.stringify({ version: "0.1.3" }),
    ],
    [join(options.workerRoot, "LICENSE"), "Apache fixture"],
    [
      join(options.workerRoot, "dist", "src", "cli", "main.js"),
      "export const fixture=true;",
    ],
    [join(options.workerRoot, "dist", "source.js.map"), "source map fixture"],
    ...[
      "__init__.py",
      "windows_gpu.py",
      "provider_adapter.py",
      "qualification.py",
      "consumer_personal.py",
    ].map((file): [string, string] => [
      join(options.workerRoot, "engine", "musicmute_engine", file),
      "# fixture\n",
    ]),
    [join(options.nodeRoot, "node.exe"), pe()],
    [join(options.nodeRoot, "LICENSE"), "Node fixture license"],
    [join(options.pythonRoot, "python.exe"), pe()],
    [join(options.pythonRoot, "LICENSE.txt"), "Python fixture license"],
    [join(options.pythonRoot, "Lib", "site-packages", "runtime.dll"), pe()],
    [join(options.mediaRoot, "bin", "ffmpeg.exe"), pe()],
    [join(options.mediaRoot, "bin", "ffprobe.exe"), pe()],
    [join(options.mediaRoot, "SOURCE-MANIFEST.json"), "{}"],
    [
      join(options.mediaRoot, "licenses", "ffmpeg", "COPYING.LGPLv2.1"),
      "LGPL fixture",
    ],
    [join(options.mediaRoot, "licenses", "lame", "COPYING"), "LGPL fixture"],
    [options.nativeBinary, pe()],
    [join(options.agentRoot, "session-agent.cjs"), "module.exports={};"],
    [join(options.agentRoot, "login-worker.cjs"), "module.exports={};"],
    [join(options.agentRoot, "fleet.cjs"), "module.exports={};"],
    [join(options.agentRoot, "personal.cjs"), "module.exports={};"],
    [join(options.agentRoot, "prepare.cjs"), "module.exports={};"],
    [join(options.downloaderRoot, "identity.json"), "{}"],
    [join(options.downloaderRoot, "downloader_bootstrap.py"), "# fixture"],
    [join(options.youtubeRoot, "identity.json"), "{}"],
    [join(options.youtubeRoot, "bin", "deno.exe"), pe()],
    [
      options.requirementsLockPath,
      "audio-separator==0.47.0\nonnxruntime-directml==1.24.4\n",
    ],
  ];
  for (const [path, contents] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return options;
}
