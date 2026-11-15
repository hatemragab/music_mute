import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORE_KIM_MDX_PYTHON_PROFILE,
  parsePackageLock,
  windowsConsumerPackagesForProfile,
} from "../../worker/src/platform/windows/consumer-package.js";
import {
  auditStorePythonDistributionMetadata,
  storeWorkerDistributionPackages,
} from "../packaging/store/audit.js";
import {
  STORE_PYTHON_OMISSIONS,
  STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS,
  STORE_MDX_RETAINED_SOURCE_PINS,
  STORE_SAMPLERATE_BINDING,
  STORE_SAMPLERATE_LIBRARY,
  assertStoreMdxUnusedDependencyOmission,
  parseStorePythonProjectionCensuses,
  parseStorePythonProjectionReceipt,
} from "../packaging/store/python-projection.js";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const lockFile = new URL(
  "../../tools/worker-gpu-feasibility/requirements-directml.lock.txt",
  import.meta.url,
);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const sorted = <T extends { path: string }>(rows: readonly T[]) =>
  [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
function censusFixture() {
  const source = sorted([
      ...STORE_PYTHON_OMISSIONS.map(({ path, bytes, sha256 }) => ({
        path,
        bytes,
        sha256,
      })),
      ...STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS,
      ...STORE_MDX_RETAINED_SOURCE_PINS,
      { path: "retained-source.txt", bytes: 10, sha256: "a".repeat(64) },
    ]),
    omissions = new Set(
      [...STORE_PYTHON_OMISSIONS, ...STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS].map(
        (p) => p.path,
      ),
    ),
    output = source.filter((p) => !omissions.has(p.path));
  return { source, output };
}
async function inputs() {
  const lock = await readFile(lockFile, "utf8"),
    source = parsePackageLock(lock),
    packages = windowsConsumerPackagesForProfile(
      lock,
      STORE_KIM_MDX_PYTHON_PROFILE,
    );
  return {
    lock,
    source,
    packages,
    receipt: {
      pythonDistributionProfile: STORE_KIM_MDX_PYTHON_PROFILE,
      pythonDependencyClosure: "product-specific-not-full-upstream",
      sourcePackages: source,
      omittedDistributions: { "diffq-fixed": "0.2.4" },
    },
  };
}
async function metadataFixture(packages: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-store-mdx-fixture-"));
  folders.push(root);
  for (const [name, version] of Object.entries(packages)) {
    const directory = join(
      root,
      "Lib/site-packages",
      `${name.replaceAll("-", "_")}-${version}.dist-info`,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "METADATA"),
      `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\nRequires-Dist: diffq-fixed==0.2.4\n\nSynthetic metadata fixture; never an upstream redistribution proof.\n`,
    );
  }
  return root;
}
describe("Store MDX product projection (code fixtures, not native/GPU proof)", () => {
  it("accounts for every original source leaf using exactly20 existing auxiliary and16 pinned diffq omissions", () => {
    const { source, output } = censusFixture();
    expect(STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS).toHaveLength(16);
    expect(STORE_MDX_RETAINED_SOURCE_PINS).toHaveLength(14);
    expect(
      parseStorePythonProjectionCensuses(encode(source), encode(output)),
    ).toEqual({ source, output });
    const legacyOutput = source.filter(
      (p) => !STORE_PYTHON_OMISSIONS.some((k) => k.path === p.path),
    );
    expect(
      parseStorePythonProjectionCensuses(
        encode(source),
        encode(legacyOutput),
        "legacy-full-source",
      ).output,
    ).toHaveLength(output.length + 16);
    expect(() =>
      parseStorePythonProjectionCensuses(encode(source), encode(legacyOutput)),
    ).toThrow();
    for (const known of STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS) {
      expect(assertStoreMdxUnusedDependencyOmission(known)).toEqual(known);
      for (const changed of [
        { ...known, path: known.path + ".unknown" },
        { ...known, bytes: known.bytes + 1 },
        { ...known, sha256: "b".repeat(64) },
        { ...known, extra: true },
      ])
        expect(() => assertStoreMdxUnusedDependencyOmission(changed)).toThrow();
    }
  });
  it("rejects missing/altered omission pins, unknown subtree leaves, extra output and any changed retained census", () => {
    const { source, output } = censusFixture(),
      omitted = STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS[0]!,
      retained = STORE_MDX_RETAINED_SOURCE_PINS[0]!,
      unknown = {
        path: "Lib/site-packages/diffq/unknown.py",
        bytes: 10,
        sha256: "a".repeat(64),
      },
      alter = (rows: typeof source, path: string) =>
        rows.map((p) =>
          p.path === path ? { ...p, sha256: "b".repeat(64) } : p,
        );
    for (const [s, o] of [
      [source.filter((p) => p.path !== omitted.path), output],
      [alter(source, omitted.path), output],
      [sorted([...source, unknown]), sorted([...output, unknown])],
      [sorted([...source, unknown]), output],
      [source, sorted([...output, omitted])],
      [source, output.filter((p) => p.path !== retained.path)],
      [source, alter(output, "retained-source.txt")],
      [alter(source, retained.path), alter(output, retained.path)],
      [
        source,
        sorted([
          ...output,
          { path: "unknown.py", bytes: 1, sha256: "a".repeat(64) },
        ]),
      ],
    ])
      expect(() =>
        parseStorePythonProjectionCensuses(encode(s), encode(o)),
      ).toThrow();
  });
  it("binds v2 proof to full63 source, exact62 product, unchanged upstream source pins and finite omissions", async () => {
    const {
        lock,
        source: packages,
        packages: retainedPackages,
      } = await inputs(),
      { source, output } = censusFixture(),
      sourceRoot = join(tmpdir(), "source-python"),
      outputRoot = join(tmpdir(), "output-python"),
      probe = (root: string, packages: Record<string, string>) => ({
        python: "3.12.10",
        architecture: "x64",
        samplerate: "0.1.0",
        chosenLibrary: join(root, STORE_SAMPLERATE_LIBRARY.path),
        chosenLibrarySha256: STORE_SAMPLERATE_LIBRARY.sha256,
        bindingSha256: STORE_SAMPLERATE_BINDING.sha256,
        inputSamples: 128,
        outputSamples: 256,
        finiteOutput: true,
        packages,
      }),
      value = {
        version: 2,
        purpose: "store-only-x64-python-projection",
        pythonDistributionProfile: STORE_KIM_MDX_PYTHON_PROFILE,
        pythonDependencyClosure: "product-specific-not-full-upstream",
        sourceRoot,
        outputRoot,
        sourceSelectedFiles: source.length,
        outputFiles: output.length,
        omissions: STORE_PYTHON_OMISSIONS,
        unusedDependencyOmissions: STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS,
        retainedSourcePins: STORE_MDX_RETAINED_SOURCE_PINS,
        sourceCensus: {
          file: "python-source-census.json",
          bytes: encode(source).length,
          sha256: hash(encode(source)),
        },
        outputCensus: {
          file: "python-projection-census.json",
          bytes: encode(output).length,
          sha256: hash(encode(output)),
        },
        requirementsLockSha256: hash(Buffer.from(lock)),
        sourceSamplerateProbe: probe(sourceRoot, packages),
        projectionSamplerateProbe: probe(outputRoot, retainedPackages),
        defaultConsumerDmlProbesRequired: true,
        legacyCorePreserved: true,
        consumerReady: false,
        storeExecutionQualified: false,
        licenseApproval: "pending",
      };
    const result = parseStorePythonProjectionReceipt(
      encode(value),
      outputRoot,
      Buffer.from(lock),
    );
    expect(result.pythonDistributionProfile).toBe(STORE_KIM_MDX_PYTHON_PROFILE);
    expect(Object.keys(result.sourceSamplerateProbe.packages)).toHaveLength(63);
    expect(Object.keys(result.projectionSamplerateProbe.packages)).toHaveLength(
      62,
    );
    for (const changed of [
      { ...value, version: 1 },
      { ...value, pythonDependencyClosure: "complete" },
      { ...value, sourceSelectedFiles: value.sourceSelectedFiles - 1 },
      { ...value, unusedDependencyOmissions: [] },
      {
        ...value,
        unusedDependencyOmissions: STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS.map(
          (p, i) => (i === 0 ? { ...p, bytes: p.bytes + 1 } : p),
        ),
      },
      { ...value, retainedSourcePins: [] },
      {
        ...value,
        retainedSourcePins: STORE_MDX_RETAINED_SOURCE_PINS.map((p, i) =>
          i === 0 ? { ...p, sha256: "a".repeat(64) } : p,
        ),
      },
      { ...value, sourceSamplerateProbe: probe(sourceRoot, retainedPackages) },
      { ...value, projectionSamplerateProbe: probe(outputRoot, packages) },
      { ...value, pythonDistributionProfile: "foreign" },
    ])
      expect(() =>
        parseStorePythonProjectionReceipt(
          encode(changed),
          outputRoot,
          Buffer.from(lock),
        ),
      ).toThrow();
  });
  it.each(["diffq", "diffq.py", "DIFFQ.cp312-win_amd64.pyd"])(
    "rejects an omitted module reintroduced as %s even without its distribution metadata",
    async (name) => {
      const { packages } = await inputs(),
        root = await metadataFixture(packages);
      await writeFile(
        join(root, "Lib/site-packages", name),
        "synthetic module fixture",
      );
      await expect(
        auditStorePythonDistributionMetadata(root, packages),
      ).rejects.toThrow();
    },
  );
  it("keeps legacy63 distinct from an explicit62 product and rejects incomplete source evidence or invented omissions", async () => {
    const { lock, source, packages, receipt } = await inputs();
    expect(storeWorkerDistributionPackages({}, lock)).toEqual(source);
    expect(storeWorkerDistributionPackages(receipt, lock)).toEqual(packages);
    for (const changed of [
      { ...receipt, pythonDistributionProfile: "foreign" },
      { ...receipt, pythonDependencyClosure: "complete" },
      { ...receipt, sourcePackages: packages },
      { ...receipt, sourcePackages: { ...source, numpy: "modified" } },
      { ...receipt, sourcePackages: { ...source, unknown: "1" } },
      { ...receipt, omittedDistributions: {} },
      { ...receipt, omittedDistributions: { "diffq-fixed": "0.2.5" } },
      {
        ...receipt,
        omittedDistributions: { "diffq-fixed": "0.2.4", numpy: "2.5.3" },
      },
      { ...receipt, pythonDistributionProfile: undefined },
    ])
      expect(() => storeWorkerDistributionPackages(changed, lock)).toThrow();
    expect(() =>
      storeWorkerDistributionPackages(
        receipt,
        lock.replace("diffq-fixed==0.2.4\n", ""),
      ),
    ).toThrow();
  });
  it("independently reads every actual retained distribution and leaves original upstream dependency declarations intact", async () => {
    const { packages } = await inputs(),
      root = await metadataFixture(packages),
      file = join(
        root,
        "Lib/site-packages/audio_separator-0.47.0.dist-info/METADATA",
      ),
      before = await readFile(file);
    await expect(
      auditStorePythonDistributionMetadata(root, packages),
    ).resolves.toBeUndefined();
    expect(hash(await readFile(file))).toBe(hash(before));
    expect(before.toString()).toContain("Requires-Dist: diffq-fixed==0.2.4");
    await rm(file);
    await expect(
      auditStorePythonDistributionMetadata(root, packages),
    ).rejects.toThrow();
  });
  it.each([
    "missing",
    "modified",
    "unknown",
    "omitted",
    "duplicate",
    "false-directory",
  ])(
    "rejects %s actual relocated metadata even when the prior receipt claims correct62",
    async (kind) => {
      const { packages } = await inputs(),
        root = await metadataFixture(packages),
        directory = join(root, "Lib/site-packages"),
        numpy = join(directory, "numpy-2.5.3.dist-info/METADATA");
      if (kind === "missing")
        await rm(join(directory, "numpy-2.5.3.dist-info"), { recursive: true });
      else if (kind === "modified")
        await writeFile(numpy, "Name: numpy\nVersion: 2.5.2\n\n");
      else if (kind === "false-directory")
        await writeFile(join(directory, "foreign-1.dist-info"), "file");
      else {
        const name =
            kind === "omitted"
              ? "diffq_fixed-0.2.4"
              : kind === "duplicate"
                ? "numpy_-2.5.3"
                : "foreign-1",
          p = join(directory, `${name}.dist-info`);
        await mkdir(p);
        await writeFile(
          join(p, "METADATA"),
          kind === "omitted"
            ? "Name: diffq-fixed\nVersion: 0.2.4\n\n"
            : kind === "duplicate"
              ? "Name: numpy\nVersion: 2.5.3\n\n"
              : "Name: foreign\nVersion: 1\n\n",
        );
      }
      await expect(
        auditStorePythonDistributionMetadata(root, packages),
      ).rejects.toThrow();
    },
  );
});
