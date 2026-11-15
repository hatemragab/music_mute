import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  link,
  lstat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { crc32, gzipSync, deflateRawSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ACQUISITION_ARTIFACTS,
  ACQUISITION_SOURCE_PINS,
  ACQUISITION_INSTALL_ARGUMENTS,
  acquisitionSourceUrl,
  acquisitionRelativePath,
  pinnedZipFiles,
  pinnedTarFiles,
  patchProviderSession,
  assertDerivedProviderLock,
  acquisitionEnvironment,
  acquisitionCmake,
  assertMembershipObservation,
  materializeAcquisitionTree,
  assembleFrozenAcquisition,
  prepareAcquisitionCohort,
  pinnedDownload,
  replaceAcquisitionGenerator,
  canvasRuntimeFiles,
  parseAcquisitionJson,
  verifyFrozenInputs,
  censusChanges,
  listFiles,
} from "./setup-windows-acquisition.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
function zip(name, content, options = {}) {
  const file = Buffer.from(name),
    data = Buffer.from(content),
    stored = options.deflate ? deflateRawSync(data) : data,
    local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    tail = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(options.flags ?? 0, 6);
  local.writeUInt16LE(options.deflate ? 8 : 0, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(stored.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(file.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(options.flags ?? 0, 8);
  central.writeUInt16LE(options.deflate ? 8 : 0, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(stored.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(file.length, 28);
  central.writeUInt32LE(options.attributes ?? 0, 38);
  tail.writeUInt32LE(0x06054b50);
  tail.writeUInt16LE(1, 8);
  tail.writeUInt16LE(1, 10);
  tail.writeUInt32LE(central.length + file.length, 12);
  tail.writeUInt32LE(local.length + file.length + stored.length, 16);
  return Buffer.concat([local, file, stored, central, file, tail]);
}
function tar(name, content, type = "0") {
  const header = Buffer.alloc(512),
    data = Buffer.from(content);
  header.write(name);
  header.write("0000600\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return gzipSync(
    Buffer.concat([
      header,
      data,
      Buffer.alloc((512 - (data.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
}
test("official platform artifacts/source snapshots match current unchanged consumer and companion pins", async () => {
  const {
    WINDOWS_CONSUMER_PINS: pins,
    WINDOWS_CONSUMER_DOWNLOADER_WHEELS: wheels,
  } = await import("../src/platform/windows/consumer-pins.ts");
  assert.equal(ACQUISITION_ARTIFACTS.deno.sha256, pins.denoArchiveSha256);
  assert.equal(ACQUISITION_ARTIFACTS.canvas.sha256, pins.canvasArchiveSha256);
  assert.equal(ACQUISITION_ARTIFACTS.node.sha256, pins.nodeArchiveSha256);
  assert.equal(wheels.length, 3);
  for (const [path, pin] of [
    [
      "src/platform/windows/consumer-pins.ts",
      ACQUISITION_SOURCE_PINS.consumerPins,
    ],
    [
      "../chrome-extension/engine/downloader_bootstrap.py",
      ACQUISITION_SOURCE_PINS.bootstrap,
    ],
    [
      "../chrome-extension/scripts/youtube-runtime/generate_once.ts",
      ACQUISITION_SOURCE_PINS.generate,
    ],
    [
      "../chrome-extension/scripts/youtube-runtime/patch-provider.py",
      ACQUISITION_SOURCE_PINS.patch,
    ],
    ["src/platform/windows/pe-imports.ts", ACQUISITION_SOURCE_PINS.peImports],
    [
      "../chrome-extension/src/shared/strict-json.ts",
      ACQUISITION_SOURCE_PINS.strictJson,
    ],
  ])
    assert.equal(hash(await readFile(path)), pin);
});
test("only primary HTTPS artifact hosts are accepted", () => {
  for (const value of [
    ACQUISITION_ARTIFACTS.deno.url,
    "https://pypi.org/pypi/yt-dlp/2026.8.19/json",
  ])
    assert.equal(acquisitionSourceUrl(value).protocol, "https:");
  for (const value of [
    "http://github.com/x",
    "https://evil.test/x",
    "https://user:secret@github.com/x",
    "https://github.com:8443/x",
    "https://github.com/x#fragment",
  ])
    assert.throws(() => acquisitionSourceUrl(value));
});
test("hoisted manual projection retains frozen Windows dependency policy without lifecycle/global authority", () => {
  assert.equal(ACQUISITION_INSTALL_ARGUMENTS[0], "install");
  for (const flag of [
    "--prod",
    "--node-modules-dir=manual",
    "--node-modules-linker=hoisted",
  ])
    assert(ACQUISITION_INSTALL_ARGUMENTS.includes(flag));
  assert.equal(
    ACQUISITION_INSTALL_ARGUMENTS[
      ACQUISITION_INSTALL_ARGUMENTS.indexOf("--os") + 1
    ],
    "win32",
  );
  assert.equal(
    ACQUISITION_INSTALL_ARGUMENTS[
      ACQUISITION_INSTALL_ARGUMENTS.indexOf("--arch") + 1
    ],
    "x64",
  );
  assert(
    !ACQUISITION_INSTALL_ARGUMENTS.some((v) =>
      /^(?:--(?:global|allow-scripts|root|force|skip-types|reload|unsafely-ignore-certificate-errors))(?:=|$)/.test(
        v,
      ),
    ),
  );
  assert(Object.isFrozen(ACQUISITION_INSTALL_ARGUMENTS));
});
test("build JSON rejects duplicate decoded keys, malformed UTF8 and nonfinite numbers", async () => {
  assert.deepEqual(await parseAcquisitionJson('{"version":1}'), { version: 1 });
  for (const text of [
    '{"version":1,"version":2}',
    '{"a":1,"\\u0061":2}',
    '{"a":1e1000}',
    '{"a":1} trailing',
  ])
    await assert.rejects(() => parseAcquisitionJson(text));
  await assert.rejects(() => parseAcquisitionJson(Buffer.from([0xff])));
  await assert.rejects(() => parseAcquisitionJson('{"version":1}', 4));
});
test("archive paths reject traversal, aliases, Windows streams and CMake characters", () => {
  for (const value of [
    "../deno.exe",
    "/deno.exe",
    "a//b",
    "a/CON.exe",
    "deno.exe:stream",
    "a\\b",
    "a/../b",
    "a;cmd",
    "a$b",
    "a/file ",
  ])
    assert.throws(() => acquisitionRelativePath(value));
  assert.equal(
    acquisitionRelativePath("build/Release/canvas.node"),
    "build/Release/canvas.node",
  );
});
test("actual ZIP bytes are CRC/size/header checked without extracting unwanted code", () => {
  for (const deflate of [false, true])
    assert.equal(
      pinnedZipFiles(
        zip("deno.exe", "fixture", { deflate }),
        new Set(["deno.exe"]),
      )
        .get("deno.exe")
        .toString(),
      "fixture",
    );
  for (const bytes of [
    zip("../deno.exe", "fixture"),
    zip("deno.exe", "fixture", { flags: 1 }),
    zip("deno.exe", "fixture", { attributes: (0xa000 << 16) >>> 0 }),
    Buffer.from("not-zip"),
  ])
    assert.throws(() => pinnedZipFiles(bytes, new Set(["deno.exe"])));
  const corrupted = zip("deno.exe", "fixture");
  corrupted[30 + 8] ^= 1;
  assert.throws(() => pinnedZipFiles(corrupted, new Set(["deno.exe"])));
  assert.throws(() =>
    pinnedZipFiles(zip("other.exe", "fixture"), new Set(["deno.exe"])),
  );
});
test("actual tar bytes verify headers and never select links/special/traversal entries", () => {
  assert.equal(
    pinnedTarFiles(tar("provider/LICENSE", "notice"), () => true)
      .get("provider/LICENSE")
      .toString(),
    "notice",
  );
  for (const bytes of [
    tar("../LICENSE", "notice"),
    tar("provider/LICENSE", "notice", "2"),
    Buffer.from("not-gzip"),
  ])
    assert.throws(() => pinnedTarFiles(bytes, () => true));
  assert.throws(
    () => patchProviderSession("foreign provider source"),
    /SOURCE_CHANGED/,
  );
});
test("Canvas keeps the finite runtime graph and rejects foreign build code", () => {
  const source = new Map([
    ["build/binding.sln", Buffer.from("project")],
    ["build/canvas.vcxproj", Buffer.from("project")],
    ["build/canvas.vcxproj.filters", Buffer.from("project")],
    ["build/config.gypi", Buffer.from("project")],
    ["build/Release/canvas.node", Buffer.from("PE audit is separate")],
    ["build/Release/libcairo-2.dll", Buffer.from("PE audit is separate")],
    ["build/Release/libstdc++-6.dll", Buffer.from("PE audit is separate")],
  ]);
  assert.deepEqual(
    [...canvasRuntimeFiles(source).keys()],
    [
      "build/Release/canvas.node",
      "build/Release/libcairo-2.dll",
      "build/Release/libstdc++-6.dll",
    ],
  );
  source.set("build/Release/postinstall.exe", Buffer.from("foreign"));
  assert.throws(() => canvasRuntimeFiles(source), /UNEXPECTED_FILE/);
  assert.throws(() => canvasRuntimeFiles(new Map()), /INCOMPLETE/);
});
test("cached artifacts are rehashed and never overwrite or accept changed bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-acquisition-test-"));
  try {
    const cache = join(root, "cache"),
      output = join(root, "output");
    await mkdir(cache);
    await mkdir(output);
    const bytes = Buffer.from("pinned artifact");
    await writeFile(join(cache, "artifact.zip"), bytes);
    const pin = {
      file: "artifact.zip",
      bytes: bytes.length,
      sha256: hash(bytes),
    };
    assert.deepEqual(await pinnedDownload(pin, output, cache), bytes);
    await assert.rejects(() => pinnedDownload(pin, output, cache), {
      code: "EEXIST",
    });
    await writeFile(join(cache, "artifact.zip"), "changed");
    await assert.rejects(
      () => pinnedDownload(pin, output, cache),
      /ARTIFACT_CHANGED/,
    );
    assert.deepEqual(await readFile(join(output, "artifact.zip")), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("generator replacement rejects a foreign upstream script before overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-acquisition-test-"));
  try {
    const path = join(root, "generate_once.ts"),
      original = Buffer.from("foreign upstream");
    await writeFile(path, original);
    const current = await readFile(
      resolve("../chrome-extension/scripts/youtube-runtime/generate_once.ts"),
    );
    await assert.rejects(
      () => replaceAcquisitionGenerator(path, current),
      /SOURCE_CHANGED/,
    );
    assert.deepEqual(await readFile(path), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("derived production lock cannot introduce or change an upstream pinned module/integrity", () => {
  const original = {
    npm: {
      "canvas@3.2.3": { integrity: "sha512-fixed" },
      "dev@1": { integrity: "sha512-dev" },
    },
    jsr: {},
    remote: {},
  };
  assertDerivedProviderLock(original, {
    npm: { "canvas@3.2.3": { integrity: "sha512-fixed" } },
    jsr: {},
    remote: {},
  });
  for (const derived of [
    { npm: { "canvas@3.2.3": { integrity: "changed" } } },
    { npm: { "foreign@1": { integrity: "fixed" } } },
    { npm: {} },
    {
      npm: { "canvas@3.2.3": { integrity: "sha512-fixed" } },
      remote: { "https://other.test": "hash" },
    },
  ])
    assert.throws(() => assertDerivedProviderLock(original, derived));
});
test("clean native environment has no inherited credentials/options/PATH and stays inside new private roots", () => {
  const env = acquisitionEnvironment(
    "C:\\MusicMuteAcceptance\\private",
    "C:\\Windows",
  );
  assert.equal(env.PATH, "");
  assert.equal(env.DENO_DISABLE_NODE_SHIM, "1");
  assert.equal(env.DENO_DIR, "C:\\MusicMuteAcceptance\\private\\deno-cache");
  assert.equal(env.HOME, "C:\\MusicMuteAcceptance\\private");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.throws(() => acquisitionEnvironment("relative", "C:\\Windows"));
  assert.throws(() => acquisitionEnvironment("C:\\safe", "C:\\foreign"));
});
test("CMake freezes Node bytes and finite source command; guard witness is supplementary and fail closed", () => {
  const recipe = acquisitionCmake({ bytes: 100, sha256: "a".repeat(64) });
  assert.match(recipe, /LANGUAGES CXX/);
  assert.match(recipe, /musicmute-acquisition-membership/);
  assert.match(recipe, /--assemble-frozen/);
  assert.match(recipe, /WINDOWS_ACQUISITION_FROZEN_INPUT_CHANGED/);
  assert.doesNotMatch(
    recipe,
    /cmd\.exe|powershell|ExecutionPolicy|--global|allow-scripts/,
  );
  const observed = {
    version: 1,
    sessionId: 1,
    inJob: true,
    killOnClose: true,
    breakaway: false,
    elevated: false,
  };
  assertMembershipObservation(observed);
  // Actual immediate-job limits may differ in a nested chain. This validation
  // grants no original-guardian certificate or permission to execute a tool.
  assertMembershipObservation({
    ...observed,
    killOnClose: false,
    breakaway: true,
  });
  for (const changed of [
    { ...observed, sessionId: 0 },
    { ...observed, inJob: false },
    { ...observed, killOnClose: "unknown" },
    { ...observed, breakaway: 0 },
    { ...observed, elevated: true },
    { ...observed, approved: true },
  ])
    assert.throws(() => assertMembershipObservation(changed));
  let called = false;
  const getter = { ...observed };
  Object.defineProperty(getter, "inJob", {
    enumerable: true,
    get() {
      called = true;
      return true;
    },
  });
  assert.throws(() => assertMembershipObservation(getter));
  assert.equal(called, false);
});
test("new owned closure materializes only internal links into regular independent files", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-acquisition-code-test-"),
  );
  try {
    const source = join(root, "source"),
      cache = join(root, "cache");
    await mkdir(source);
    await mkdir(cache);
    await writeFile(join(cache, "module.js"), "export const fixed = true;");
    await symlink(join(cache, "module.js"), join(source, "module.js"));
    await link(join(cache, "module.js"), join(source, "cached-hardlink.js"));
    await mkdir(join(source, ".deno"));
    await writeFile(join(source, ".deno", ".deno.lock"), Buffer.alloc(0));
    await writeFile(join(source, "empty-module.js"), Buffer.alloc(0));
    await writeFile(join(source, "source.js.map"), "build-only");
    const destination = join(root, "output");
    await materializeAcquisitionTree(source, destination, root);
    assert.equal(
      (await readFile(join(destination, "module.js"))).toString(),
      "export const fixed = true;",
    );
    const stat = await lstat(join(destination, "module.js"));
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.equal((await lstat(join(source, "cached-hardlink.js"))).nlink, 2);
    assert.equal(
      (await lstat(join(destination, "cached-hardlink.js"))).nlink,
      1,
    );
    for (const empty of [".deno/.deno.lock", "empty-module.js"]) {
      const target = join(destination, ...empty.split("/"));
      assert.equal((await readFile(target)).length, 0);
      assert.equal((await lstat(target)).nlink, 1);
      assert.equal(
        hash(await readFile(target)),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    }
    assert.deepEqual(
      await readFile(join(destination, "cached-hardlink.js")),
      await readFile(join(cache, "module.js")),
    );
    await assert.rejects(lstat(join(destination, "source.js.map")), {
      code: "ENOENT",
    });
    await symlink("/etc/hosts", join(source, "foreign.js"));
    await assert.rejects(
      materializeAcquisitionTree(source, join(root, "foreign-output"), root),
      /LINK_ESCAPE/,
    );
    await rm(join(source, "foreign.js"));
    await writeFile(join(source, "empty.exe"), Buffer.alloc(0));
    await assert.rejects(
      materializeAcquisitionTree(source, join(root, "empty-code-output"), root),
      /CLOSURE_INVALID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("frozen source census rejects additions, duplicate fields and changed inputs", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-acquisition-frozen-test-"),
  );
  try {
    const names = [
      "source/setup-windows-acquisition.mjs",
      "source/consumer-pins.ts",
      "source/pe-audit.ts",
      "source/pe-imports.ts",
      "source/strict-json.ts",
      "source/owned-code-acl.ps1",
      "repository/worker/native/windows-consumer/membership.cpp",
      "repository/worker/native/windows-consumer/CMakeLists.txt",
      "tools/node/node.exe",
      "base/youtube/bin/deno.exe",
      "raw/pinned.zip",
      "metadata/public.json",
    ].sort();
    const data = Buffer.from(
      "synthetic bytes for census only; never executable evidence",
    );
    for (const path of names) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), data);
    }
    const value = {
      version: 1,
      purpose: "windows-acquisition-build-inputs",
      files: names.map((path) => ({
        path,
        bytes: data.length,
        sha256: hash(data),
      })),
    };
    const path = join(root, "frozen-inputs.json");
    await writeFile(path, JSON.stringify(value));
    await verifyFrozenInputs(root);
    await writeFile(
      join(root, "source", "unexpected.js"),
      "unexpected executable source",
    );
    await assert.rejects(
      () => verifyFrozenInputs(root),
      /FROZEN_INPUT_CHANGED/,
    );
    await rm(join(root, "source", "unexpected.js"));
    await writeFile(
      path,
      JSON.stringify(value).replace('"version":1', '"version":1,"version":2'),
    );
    await assert.rejects(() => verifyFrozenInputs(root));
    await writeFile(path, JSON.stringify(value));
    await writeFile(join(root, "source/pe-imports.ts"), "changed source");
    await assert.rejects(
      () => verifyFrozenInputs(root),
      /FROZEN_INPUT_CHANGED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("post-probe census detects changes/additions/removal and keeps exact empty pins without getter or native-empty exceptions", () => {
  const empty = {
    path: "provider/node_modules/.deno/.deno.lock",
    bytes: 0,
    sha256: hash(Buffer.alloc(0)),
  };
  const source = {
    path: "provider/src/source.ts",
    bytes: 7,
    sha256: hash(Buffer.from("source1")),
  };
  assert.deepEqual(censusChanges([empty, source], [empty, source]), []);
  const changed = { ...source, sha256: hash(Buffer.from("source2")) };
  assert.deepEqual(
    censusChanges([empty, source], [empty, changed]).map((row) => [
      row.path,
      row.change,
    ]),
    [[source.path, "changed"]],
  );
  assert.equal(censusChanges([empty, source], [source])[0].change, "removed");
  assert.equal(censusChanges([source], [empty, source])[0].change, "added");
  for (const invalid of [
    [{ ...empty, sha256: "a".repeat(64) }],
    [{ ...empty, path: "bin/deno.exe" }],
    [source, empty],
    [empty, { ...empty, path: empty.path.toUpperCase() }],
    [{ ...source, approved: true }],
  ])
    assert.throws(() => censusChanges(invalid, []));
  let called = false;
  const getter = { ...source };
  Object.defineProperty(getter, "sha256", {
    enumerable: true,
    get() {
      called = true;
      return source.sha256;
    },
  });
  assert.throws(() => censusChanges([getter], []));
  assert.equal(called, false);
});
test("failed held census retains bounded leaf metadata without relaxing private single-link admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-acquisition-census-"));
  try {
    const target = join(root, "fixed.js");
    await writeFile(target, "fixed-source");
    assert.deepEqual(await listFiles(root), [
      {
        path: "fixed.js",
        bytes: 12,
        sha256: hash(Buffer.from("fixed-source")),
      },
    ]);
    await link(target, join(root, "second.js"));
    await assert.rejects(listFiles(root), (error) => {
      assert.equal(error.message, "WINDOWS_ACQUISITION_CENSUS_FAILED");
      assert.equal(error.censusDiagnostic.path, "fixed.js");
      assert.equal(error.censusDiagnostic.held.stage, "named-leaf");
      assert.equal(error.censusDiagnostic.held.observations[0].links, "2");
      assert(!JSON.stringify(error.censusDiagnostic).includes("fixed-source"));
      assert(!JSON.stringify(error.censusDiagnostic).includes(root));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("physical mode cannot be invoked on Mac or with skip flags, and fetch never overwrites an existing cohort", async () => {
  if (process.platform !== "win32")
    await assert.rejects(assembleFrozenAcquisition(), /NATIVE_REQUIRED/);
  const root = await mkdtemp(join(tmpdir(), "musicmute-acquisition-existing-"));
  try {
    await assert.rejects(prepareAcquisitionCohort(root), { code: "EEXIST" });
    const result = await promisify(execFile)(process.execPath, [
      resolve("scripts/setup-windows-acquisition.mjs"),
      "--assemble-frozen",
      "--skip-guard",
    ]).catch((e) => e);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /BUILD_ARGUMENT_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
