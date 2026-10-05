import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface ReleaseResult {
  release_root: string;
  dmg?: string;
  runtime_zip?: string;
  runtime_manifest?: string;
  submission_id?: string;
  runtime_submission_id?: string;
  state: string;
  public_ready: boolean;
  notarized: boolean;
  runtime_notarized?: boolean;
  runtime_stapled?: boolean;
  stapled?: boolean;
  clean_user_launch_tested?: boolean;
  relocated_runtime_tested?: boolean;
  sha256?: string;
}
interface ReleaseOptions {
  packageResult?: string;
  identity?: string;
  keychainProfile?: string;
  releaseRoot?: string;
  resume?: string;
  prepareOnly?: boolean;
  submit?: boolean;
}
interface Configuration {
  release: boolean;
  identity: string;
  teamIdentifier: string;
  authority: string;
}
interface CommandSettings {
  timeout: number;
  maxBuffer: number;
  env: Record<string, string>;
  windowsHide?: boolean;
}
interface Invocation {
  file: string;
  args: string[];
  settings: CommandSettings;
}
interface Dependencies {
  root: string;
  platform: string;
  arch: string;
  exec: (
    file: string,
    args: string[],
    settings: CommandSettings,
  ) => Promise<{ stdout: string; stderr: string }>;
  signing: {
    resolveSigningConfiguration: () => Promise<Configuration>;
    signingArguments: (
      configuration: Configuration,
      settings: { kind: string },
    ) => string[];
    verifyDeveloperIdSignature: (
      path: string,
      configuration: Configuration,
      settings: { kind: string },
    ) => Promise<void>;
  };
}
interface ReleaseModule {
  parseReleaseOptions(args: string[]): ReleaseOptions;
  sanitizeNotaryLog(
    log: Record<string, unknown>,
    expected: { id: string; filename: string; sha256: string },
  ): Record<string, unknown>;
  releaseMacos(
    args: string[],
    dependencies: Dependencies,
  ): Promise<ReleaseResult>;
}
const url = new URL("../scripts/release-macos.mjs", import.meta.url).href;
const { parseReleaseOptions, releaseMacos, sanitizeNotaryLog } = (await import(
  url
)) as ReleaseModule;
const identity = "A".repeat(40);
const team = "A123456789";
const profile = "MusicMute-Notary";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { force: true, recursive: true });
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "musicmute-notary-fixture-")),
  );
  roots.push(root);
  const buildId = randomUUID();
  const build = join(root, "output/macos", `build-${buildId}.noindex`);
  const app = join(build, "MusicMute Local.app");
  const resources = join(app, "Contents/Resources");
  await mkdir(resources, { recursive: true });
  await writeFile(join(app, "Contents/Info.plist"), "fixture plist");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ version: "0.1.0" }),
  );
  const runtimePayload = join(root, "runtime-payload");
  const runtimeContents = new Map<string, Buffer>([
    [
      "runtime/runtime/node/bin/node",
      Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.from("node")]),
    ],
    ["runtime/runtime/python/bin/python3", Buffer.from("python")],
    ["runtime/runtime/bin/ffmpeg", Buffer.from("ffmpeg")],
    ["runtime/runtime/bin/ffprobe", Buffer.from("ffprobe")],
    ["runtime/tools/youtube/bin/deno", Buffer.from("deno")],
  ]);
  const runtimeFiles: Array<Record<string, unknown>> = [];
  for (const [path, bytes] of runtimeContents) {
    const absolute = join(runtimePayload, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, bytes, { mode: 0o755 });
    runtimeFiles.push({
      path,
      type: "file",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      executable: true,
      code_signed: path.endsWith("/node"),
    });
  }
  const runtimeDirectLink = "runtime/runtime/node/bin/node-link";
  await symlink("node", join(runtimePayload, runtimeDirectLink));
  runtimeFiles.push({
    path: runtimeDirectLink,
    type: "symlink",
    link_target: "node",
  });
  const runtimeLink = "runtime/runtime/node/bin/node-current";
  await symlink("node-link", join(runtimePayload, runtimeLink));
  runtimeFiles.push({
    path: runtimeLink,
    type: "symlink",
    link_target: "node-link",
  });
  const runtimeDirectoryLink = "runtime/runtime/node/bin-current";
  await symlink("bin", join(runtimePayload, runtimeDirectoryLink));
  runtimeFiles.push({
    path: runtimeDirectoryLink,
    type: "symlink",
    link_target: "bin",
  });
  const runtimeDirectoryChain = "runtime/runtime/node/bin-active";
  await symlink("bin-current", join(runtimePayload, runtimeDirectoryChain));
  runtimeFiles.push({
    path: runtimeDirectoryChain,
    type: "symlink",
    link_target: "bin-current",
  });
  runtimeFiles.sort((left, right) =>
    String(left.path).localeCompare(String(right.path)),
  );
  const runtimeDirectory = join(build, "runtime-release.noindex");
  await mkdir(runtimeDirectory, { mode: 0o700 });
  const runtimeId = "macos-arm64-v1-fixture";
  const archiveFixtureBytes = Buffer.from("signed runtime ZIP fixture");
  const runtimeArchiveSha256 = createHash("sha256")
    .update(archiveFixtureBytes)
    .digest("hex");
  const runtimeFilename = `MusicMuteLocal-runtime-${runtimeId}-${runtimeArchiveSha256.slice(0, 16)}.zip`;
  const runtimeArchive = join(runtimeDirectory, runtimeFilename);
  await writeFile(runtimeArchive, archiveFixtureBytes, { mode: 0o600 });
  const installedBytes = runtimeFiles.reduce(
    (total, entry) => total + (entry.type === "file" ? Number(entry.bytes) : 0),
    0,
  );
  const runtimeUrl = `https://downloads.example.test/runtime/${runtimeFilename}`;
  const runtimeManifest = {
    schema_version: 1,
    runtime: {
      id: runtimeId,
      api_version: 1,
      platform: "darwin",
      arch: "arm64",
      url: runtimeUrl,
      archive_format: "zip",
      archive_sha256: runtimeArchiveSha256,
      archive_bytes: archiveFixtureBytes.length,
      installed_bytes: installedBytes,
      download_hosts: ["downloads.example.test"],
      signing: { mode: "developer_id", team_id: team },
      files: runtimeFiles,
    },
  };
  const runtimeManifestBytes = `${JSON.stringify(runtimeManifest, null, 2)}\n`;
  const runtimeManifestPath = join(runtimeDirectory, "runtime-bootstrap.json");
  await writeFile(runtimeManifestPath, runtimeManifestBytes, { mode: 0o600 });
  await writeFile(
    join(resources, "runtime-bootstrap.json"),
    runtimeManifestBytes,
    { mode: 0o644 },
  );
  const runtimeManifestSha256 = createHash("sha256")
    .update(runtimeManifestBytes)
    .digest("hex");
  const packageResult = join(build, "package-result.json");
  const packaged = {
    schema_version: 1,
    build_id: buildId,
    app,
    build_root: build,
    signing: "DEVELOPER_ID_DISTRIBUTION",
    release_mode: true,
    architecture: "arm64",
    secure_timestamp: true,
    hardened_runtime: true,
    signing_identity_sha1: identity,
    team_identifier: team,
    notarized: false,
    public_ready: false,
    relocated_runtime_tested: false,
    version: "0.1.0",
    build: "1",
    runtime: {
      delivery: "EXTERNAL_PREPARE",
      id: runtimeId,
      archive: runtimeArchive,
      archive_bytes: archiveFixtureBytes.length,
      archive_sha256: runtimeArchiveSha256,
      installed_bytes: installedBytes,
      manifest: runtimeManifestPath,
      manifest_sha256: runtimeManifestSha256,
      url: runtimeUrl,
      files: runtimeFiles.length,
      native_binaries: 1,
      native_binaries_verified: 1,
      signing: { mode: "developer_id", team_id: team },
      notarized: false,
      public_ready: false,
    },
  };
  await writeFile(packageResult, JSON.stringify(packaged));
  const calls: Invocation[] = [];
  const verifications: { path: string; kind: string }[] = [];
  const submissionId = randomUUID();
  const runtimeSubmissionId = randomUUID();
  const behavior = {
    status: "Accepted",
    runtimeStatus: null as string | null,
    failSubmit: false,
    failRuntimeSubmit: false,
    invalidSubmitJson: false,
    failStaple: false,
    failAppAssessment: false,
    failDmgAssessment: false,
    failAppSignature: false,
    failRuntimeSignature: false,
    wrongInfoName: false,
    wrongRuntimeInfoName: false,
    wrongLogHash: false,
    missingLogHash: false,
    failDetach: false,
    attachTimeoutAfterMount: false,
    logStatus: null as string | null,
  };
  let filename = "";
  let uploadedImage = "";
  let copiedContents = "";
  let installText = "";
  const mountedImages = new Map<string, { image: string; device: string }>();
  const dependencies: Dependencies = {
    root,
    platform: "darwin",
    arch: "arm64",
    signing: {
      resolveSigningConfiguration: async () => ({
        release: true,
        identity,
        teamIdentifier: team,
        authority: `Developer ID Application: Fixture (${team})`,
      }),
      signingArguments: (_configuration, { kind }) => {
        expect(kind).toBe("dmg");
        return ["--force", "--sign", identity, "--timestamp"];
      },
      verifyDeveloperIdSignature: async (path, _configuration, { kind }) => {
        verifications.push({ path, kind });
        if (behavior.failAppSignature && kind === "app")
          throw new Error("RELEASE_SIGNATURE_VERIFICATION_FAILED");
        if (behavior.failRuntimeSignature && kind === "binary")
          throw new Error("RELEASE_SIGNATURE_VERIFICATION_FAILED");
      },
    },
    exec: async (file, args, settings) => {
      calls.push({ file, args, settings });
      if (file === "/usr/bin/ditto") {
        if (args[0] === "-x")
          await cp(
            join(runtimePayload, "runtime"),
            join(args.at(-1)!, "runtime"),
            { recursive: true, verbatimSymlinks: true },
          );
        else await cp(args[0]!, args[1]!, { recursive: true });
        return { stdout: "", stderr: "" };
      }
      if (file === "/usr/bin/unzip")
        return {
          stdout: `${runtimeFiles.map((entry) => entry.path).join("\n")}\n`,
          stderr: "",
        };
      if (file === "/usr/bin/plutil")
        return {
          stdout:
            args[0] === "-convert"
              ? await readFile(args.at(-1)!, "utf8")
              : args[1] === "CFBundleShortVersionString"
                ? "0.1.0\n"
                : args[1] === "CFBundleVersion"
                  ? "1\n"
                  : "com.hatem.musicmute.local\n",
          stderr: "",
        };
      if (file === "/usr/bin/hdiutil" && args[0] === "info")
        return {
          stdout: JSON.stringify({
            images: Array.from(mountedImages, ([mount, value]) => ({
              "image-path": value.image,
              "system-entities": [
                { "mount-point": mount, "dev-entry": value.device },
              ],
            })),
          }),
          stderr: "",
        };
      if (file === "/usr/bin/hdiutil" && args[0] === "create") {
        filename = basename(args.at(-1)!);
        uploadedImage = args.at(-1)!;
        const releaseDirectory = dirname(uploadedImage);
        expect(await readFile(join(releaseDirectory, runtimeFilename))).toEqual(
          archiveFixtureBytes,
        );
        expect(
          await readFile(
            join(releaseDirectory, "runtime-bootstrap.json"),
            "utf8",
          ),
        ).toBe(await readFile(runtimeManifestPath, "utf8"));
        await expect(
          lstat(join(releaseDirectory, "notarization-receipt.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const imageSource = args[args.indexOf("-srcfolder") + 1]!;
        expect((await lstat(imageSource)).mode & 0o777).toBe(0o755);
        copiedContents = await readFile(
          join(imageSource, "MusicMute Local.app/Contents/Info.plist"),
          "utf8",
        );
        installText = await readFile(
          join(imageSource, "Install MusicMute.txt"),
          "utf8",
        );
        expect(
          (await lstat(join(imageSource, "Applications"))).isSymbolicLink(),
        ).toBe(true);
        await writeFile(args.at(-1)!, "signed DMG fixture");
      }
      if (file === "/usr/bin/xcrun" && args[0] === "notarytool") {
        if (args[1] === "submit") {
          const runtime = basename(args[2]!) === runtimeFilename;
          if (
            (!runtime && behavior.failSubmit) ||
            (runtime && behavior.failRuntimeSubmit)
          )
            throw Object.assign(
              new Error("password SECRET account@example.test"),
              {
                stderr: "SECRET https://private.invalid/token=SECRET",
              },
            );
          return {
            stdout:
              !runtime && behavior.invalidSubmitJson
                ? "SECRET invalid JSON"
                : JSON.stringify({
                    id: runtime ? runtimeSubmissionId : submissionId,
                  }),
            stderr: "",
          };
        }
        if (args[1] === "info") {
          const runtime = args[2] === runtimeSubmissionId;
          return {
            stdout: JSON.stringify({
              id: args[2],
              name:
                (!runtime && behavior.wrongInfoName) ||
                (runtime && behavior.wrongRuntimeInfoName)
                  ? "other.invalid"
                  : runtime
                    ? runtimeFilename
                    : filename,
              status: runtime
                ? (behavior.runtimeStatus ?? behavior.status)
                : behavior.status,
              createdDate: "2026-10-03T00:00:00Z",
              privateEmail: "account@example.test",
            }),
            stderr: "",
          };
        }
        if (args[1] === "log") {
          const runtime = args[2] === runtimeSubmissionId;
          const targetStatus = runtime
            ? (behavior.runtimeStatus ?? behavior.status)
            : behavior.status;
          const targetPath = runtime ? runtimeArchive : uploadedImage;
          return {
            stdout: JSON.stringify({
              jobId: args[2]!.toUpperCase(),
              archiveFilename: runtime ? runtimeFilename : filename,
              status: runtime
                ? targetStatus
                : (behavior.logStatus ?? targetStatus),
              ...(!runtime && behavior.missingLogHash
                ? {}
                : {
                    sha256:
                      !runtime && behavior.wrongLogHash
                        ? "0".repeat(64)
                        : createHash("sha256")
                            .update(await readFile(targetPath))
                            .digest("hex"),
                  }),
              issues:
                targetStatus === "Accepted"
                  ? []
                  : [
                      {
                        severity: "error",
                        message:
                          "The signature does not include a secure timestamp. SECRET https://private.invalid",
                        path: `${filename}/MusicMute Local.app/Contents/MacOS/MusicMuteLocal`,
                        architecture: "arm64",
                      },
                    ],
              ticketContents: { privateUnknownValue: "SECRET" },
            }),
            stderr: "",
          };
        }
      }
      if (
        file === "/usr/bin/xcrun" &&
        args[0] === "stapler" &&
        args[1] === "staple"
      ) {
        if (behavior.failStaple) throw new Error("SECRET stapler failed");
        const text = await readFile(args[2]!, "utf8");
        if (!text.endsWith("ticket")) await appendFile(args[2]!, "ticket");
      }
      if (file === "/usr/bin/hdiutil" && args[0] === "attach") {
        const mount = args[args.indexOf("-mountpoint") + 1]!;
        await cp(app, join(mount, "MusicMute Local.app"), { recursive: true });
        mountedImages.set(mount, {
          image: args.at(-1)!,
          device: "/dev/disk999s1",
        });
        if (behavior.attachTimeoutAfterMount)
          throw new Error("SECRET attach timed out");
      }
      if (file === "/usr/bin/hdiutil" && args[0] === "detach") {
        if (behavior.failDetach) throw new Error("SECRET detach failed");
        const mounted = Array.from(mountedImages).find(
          ([, value]) => value.device === args[1],
        );
        if (!mounted) throw new Error("UNKNOWN_FIXTURE_DEVICE");
        await rm(join(mounted[0], "MusicMute Local.app"), { recursive: true });
        mountedImages.delete(mounted[0]);
      }
      if (file === "/usr/sbin/spctl") {
        const isApp = args.includes("exec");
        if (
          (isApp && behavior.failAppAssessment) ||
          (!isApp && behavior.failDmgAssessment)
        )
          throw new Error("SECRET Gatekeeper rejected");
        return {
          stdout: "",
          stderr:
            "accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Fixture",
        };
      }
      return { stdout: "", stderr: "" };
    },
  };
  const args = ["--package-result", packageResult, "--identity", identity];
  return {
    root,
    app,
    packageResult,
    packaged,
    dependencies,
    calls,
    verifications,
    behavior,
    submissionId,
    runtimeSubmissionId,
    args,
    content: () => ({ copiedContents, installText }),
    mountedImages,
    runtimeArchive,
    runtimeManifestPath,
    runtimeManifestBytes,
    runtimeManifest,
    runtimeFiles,
    runtimePayload,
  };
}

async function receipt(directory: string) {
  return JSON.parse(
    await readFile(join(directory, "notarization-receipt.json"), "utf8"),
  ) as Record<string, unknown>;
}
function resume(directory: string, id: string) {
  return [
    "--release-root",
    directory,
    "--resume",
    id,
    "--keychain-profile",
    profile,
  ];
}
function submit(directory: string) {
  return [
    "--release-root",
    directory,
    "--submit",
    "--keychain-profile",
    profile,
  ];
}

describe("explicit direct-distribution release arguments", () => {
  it("supports a preflight without notarization credentials", () => {
    expect(
      parseReleaseOptions([
        "--package-result",
        "/fixture/result",
        "--identity",
        identity,
        "--prepare-only",
      ]),
    ).toEqual({
      packageResult: "/fixture/result",
      identity,
      prepareOnly: true,
    });
  });
  it.each(
    [
      [],
      ["--apple-id", "private@example.test"],
      ["--password", "SECRET"],
      ["--key", "/secret.p8"],
      [
        "--package-result",
        "/fixture/result",
        "--identity",
        "-",
        "--prepare-only",
      ],
      [
        "--package-result",
        "/fixture/result",
        "--identity",
        identity,
        "--prepare-only",
        "--keychain-profile",
        profile,
      ],
      [
        "--release-root",
        "/fixture/release",
        "--submit",
        "--resume",
        randomUUID(),
        "--keychain-profile",
        profile,
      ],
      [
        "--release-root",
        "/fixture/release",
        "--resume",
        "bad-id",
        "--keychain-profile",
        profile,
      ],
      ["--release-root", "/fixture/release", "--submit"],
      [
        "--package-result",
        "/fixture/result",
        "--identity",
        identity,
        "--prepare-only",
        "--prepare-only",
      ],
      [
        "--package-result",
        "/fixture/result",
        "--identity",
        identity,
        "--keychain-profile",
        "profile\nSECRET",
      ],
    ].map((args) => ({ args })),
  )(
    "rejects secret-bearing, ambiguous or malformed arguments $args",
    ({ args }) => {
      expect(() => parseReleaseOptions(args)).toThrow(
        "INVALID_RELEASE_OPTIONS",
      );
    },
  );
});

describe("signed DMG preparation and notarization lifecycle", () => {
  it("prepares a drag-and-drop DMG, instructions and strict app/container verification without upload", async () => {
    const context = await fixture();
    const result = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    expect(result).toMatchObject({
      state: "PREPARED",
      public_ready: false,
      notarized: false,
    });
    expect(context.content().copiedContents).toBe("fixture plist");
    expect(context.content().installText).toContain(
      "Drag MusicMute Local.app onto Applications",
    );
    expect(context.content().installText).toContain(
      "downloads and verifies the signed processing runtime",
    );
    expect(context.content().installText).toContain(
      `${context.packaged.runtime.archive_bytes} B download; ${context.packaged.runtime.installed_bytes} B installed`,
    );
    expect(context.content().installText).toContain(
      "separate 66.8 MB voice model",
    );
    expect(context.content().installText).toContain(
      "Runtime tools and model weights are not included in this installer",
    );
    expect(context.content().installText).toContain(
      "Chrome Web Store release is separate",
    );
    expect(context.calls.some((call) => call.args.includes("notarytool"))).toBe(
      false,
    );
    expect(
      context.calls.find((call) => call.file === "/usr/bin/unzip")?.settings
        .maxBuffer,
    ).toBe(16 * 1024 * 1024);
    expect(
      context.verifications.filter((entry) => entry.kind === "app"),
    ).toHaveLength(2);
    expect(
      context.calls.find((call) => call.file === "/usr/bin/codesign")?.args,
    ).toContain("--timestamp");
    expect((await lstat(result.release_root)).mode & 0o777).toBe(0o700);
    expect(
      (await lstat(join(result.release_root, "notarization-receipt.json")))
        .mode & 0o777,
    ).toBe(0o600);
    expect(
      (await readdir(result.release_root)).some(
        (name) => name === "accepted.noindex",
      ),
    ).toBe(false);
    expect(
      await readFile(join(context.app, "Contents/Info.plist"), "utf8"),
    ).toBe("fixture plist");
    for (const { settings } of context.calls) {
      expect(settings.timeout).toBeGreaterThan(0);
      expect(settings.timeout).toBeLessThanOrEqual(1_200_000);
      expect(settings.maxBuffer).toBeGreaterThan(0);
      expect(settings.maxBuffer).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(Object.keys(settings.env).sort()).toEqual([
        "HOME",
        "LANG",
        "PATH",
      ]);
    }
  });
  it.each([
    { schema_version: 2 },
    { build_id: randomUUID() },
    { signing: "AD_HOC_LOCAL" },
    { release_mode: false },
    { architecture: "x64" },
    { hardened_runtime: false },
    { secure_timestamp: false },
    { signing_identity_sha1: "B".repeat(40) },
    { notarized: true },
    { public_ready: true },
    { app: "/Applications/Other.app" },
  ])(
    "refuses a development, stale or wrong package before signing/upload: %j",
    async (changes) => {
      const context = await fixture();
      await writeFile(
        context.packageResult,
        JSON.stringify({ ...context.packaged, ...changes }),
      );
      await expect(
        releaseMacos([...context.args, "--prepare-only"], context.dependencies),
      ).rejects.toThrow("NOT_A_DISTRIBUTION_PACKAGE");
      expect(context.calls).toHaveLength(0);
    },
  );
  it("refuses latest.json even when it points to a release-shaped package", async () => {
    const context = await fixture();
    const latest = join(context.root, "output/macos/latest.json");
    await writeFile(latest, JSON.stringify(context.packaged));
    await expect(
      releaseMacos(
        ["--package-result", latest, "--identity", identity, "--prepare-only"],
        context.dependencies,
      ),
    ).rejects.toThrow("EXPLICIT_RELEASE_PACKAGE_REQUIRED");
    expect(context.calls).toHaveLength(0);
  });
  it("requires the external runtime metadata for every thin release package", async () => {
    const context = await fixture();
    const { runtime: _runtime, ...withoutRuntime } = context.packaged;
    await writeFile(context.packageResult, JSON.stringify(withoutRuntime));
    await expect(
      releaseMacos([...context.args, "--prepare-only"], context.dependencies),
    ).rejects.toThrow("EXTERNAL_RUNTIME_PACKAGE_REQUIRED");
    expect(
      context.calls.some(
        (call) => call.args[0] === "create" || call.args[1] === "submit",
      ),
    ).toBe(false);
  });
  it("requires runtime artifacts to stay under the exact package build root", async () => {
    const context = await fixture();
    const escapedManifest = join(context.root, "runtime-bootstrap.json");
    await writeFile(escapedManifest, context.runtimeManifestBytes, {
      mode: 0o600,
    });
    await writeFile(
      context.packageResult,
      JSON.stringify({
        ...context.packaged,
        runtime: { ...context.packaged.runtime, manifest: escapedManifest },
      }),
    );
    await expect(
      releaseMacos([...context.args, "--prepare-only"], context.dependencies),
    ).rejects.toThrow("RUNTIME_PACKAGE_PATH_INVALID");
  });
  it("requires the embedded bootstrap raw bytes to equal the sidecar", async () => {
    const context = await fixture();
    await appendFile(
      join(context.app, "Contents/Resources/runtime-bootstrap.json"),
      " ",
    );
    await expect(
      releaseMacos([...context.args, "--prepare-only"], context.dependencies),
    ).rejects.toThrow("RUNTIME_EMBEDDED_MANIFEST_MISMATCH");
  });
  it("reads runtime manifests with the aligned 16 MiB ceiling", async () => {
    const acceptedContext = await fixture();
    const acceptedManifest = `${JSON.stringify(
      acceptedContext.runtimeManifest,
      null,
      2,
    )}\n${" ".repeat(70 * 1024)}`;
    const acceptedSha256 = createHash("sha256")
      .update(acceptedManifest)
      .digest("hex");
    await writeFile(acceptedContext.runtimeManifestPath, acceptedManifest);
    await writeFile(
      join(acceptedContext.app, "Contents/Resources/runtime-bootstrap.json"),
      acceptedManifest,
    );
    await writeFile(
      acceptedContext.packageResult,
      JSON.stringify({
        ...acceptedContext.packaged,
        runtime: {
          ...acceptedContext.packaged.runtime,
          manifest_sha256: acceptedSha256,
        },
      }),
    );
    await expect(
      releaseMacos(
        [...acceptedContext.args, "--prepare-only"],
        acceptedContext.dependencies,
      ),
    ).resolves.toMatchObject({ state: "PREPARED", public_ready: false });

    const context = await fixture();
    await writeFile(
      context.runtimeManifestPath,
      Buffer.alloc(16 * 1024 * 1024 + 1, 0x20),
    );
    await expect(
      releaseMacos([...context.args, "--prepare-only"], context.dependencies),
    ).rejects.toThrow("RUNTIME_MANIFEST_TOO_LARGE");
  });
  it("rejects a thin app that still embeds a runtime directory", async () => {
    const context = await fixture();
    await mkdir(join(context.app, "Contents/Resources/runtime"));
    await expect(
      releaseMacos([...context.args, "--prepare-only"], context.dependencies),
    ).rejects.toThrow("THIN_APP_CONTAINS_RUNTIME");
  });
  it("rechecks archive bytes and exact extracted inventory before creating a receipt", async () => {
    const context = await fixture();
    await appendFile(context.runtimeArchive, "changed");
    await expect(
      releaseMacos([...context.args, "--prepare-only"], context.dependencies),
    ).rejects.toThrow("RUNTIME_ARCHIVE_DIGEST_MISMATCH");
    expect(context.calls.some((call) => call.args[0] === "create")).toBe(false);

    const inventoryContext = await fixture();
    await appendFile(
      join(inventoryContext.runtimePayload, "runtime/runtime/bin/ffmpeg"),
      "changed",
    );
    await expect(
      releaseMacos(
        [...inventoryContext.args, "--prepare-only"],
        inventoryContext.dependencies,
      ),
    ).rejects.toThrow("RUNTIME_EXTRACTED_INVENTORY_MISMATCH");

    const modeContext = await fixture();
    await chmod(
      join(modeContext.runtimePayload, "runtime/runtime/bin/ffprobe"),
      0o644,
    );
    await expect(
      releaseMacos(
        [...modeContext.args, "--prepare-only"],
        modeContext.dependencies,
      ),
    ).rejects.toThrow("RUNTIME_EXTRACTED_INVENTORY_MISMATCH");
  });
  it.each([
    {
      target: "missing",
      error: "RUNTIME_LINK_DANGLING_OR_CYCLIC",
    },
    {
      target: "node-current",
      error: "RUNTIME_LINK_DANGLING_OR_CYCLIC",
    },
    {
      target: "..",
      error: "RUNTIME_LINK_DANGLING_OR_CYCLIC",
    },
    {
      target: "../../../unlisted-empty",
      error: "RUNTIME_LINK_DANGLING_OR_CYCLIC",
    },
    {
      target: "missing/../node",
      error: "RUNTIME_LINK_UNSAFE",
    },
    {
      target: "../bin-current/node",
      error: "RUNTIME_LINK_UNSAFE",
    },
    {
      target: "../../../../outside",
      error: "RUNTIME_LINK_UNSAFE",
    },
  ])(
    "rejects extracted runtime symlinks that are dangling or escape the payload: $target",
    async ({ target, error }) => {
      const context = await fixture();
      const linkPath = "runtime/runtime/node/bin/node-current";
      if (target === "../../../unlisted-empty")
        await mkdir(join(context.runtimePayload, "runtime/unlisted-empty"));
      await rm(join(context.runtimePayload, linkPath));
      await symlink(target, join(context.runtimePayload, linkPath));
      const changedManifest = structuredClone(context.runtimeManifest);
      const entry = changedManifest.runtime.files.find(
        (candidate) => candidate.path === linkPath,
      );
      expect(entry).toBeDefined();
      entry!.link_target = target;
      const manifestBytes = `${JSON.stringify(changedManifest, null, 2)}\n`;
      const manifestSha256 = createHash("sha256")
        .update(manifestBytes)
        .digest("hex");
      await writeFile(context.runtimeManifestPath, manifestBytes);
      await writeFile(
        join(context.app, "Contents/Resources/runtime-bootstrap.json"),
        manifestBytes,
      );
      await writeFile(
        context.packageResult,
        JSON.stringify({
          ...context.packaged,
          runtime: {
            ...context.packaged.runtime,
            manifest_sha256: manifestSha256,
          },
        }),
      );
      await expect(
        releaseMacos([...context.args, "--prepare-only"], context.dependencies),
      ).rejects.toThrow(error);
    },
  );
  it("verifies every manifest-declared Mach-O with the selected Developer ID team", async () => {
    const context = await fixture();
    context.behavior.failRuntimeSignature = true;
    await expect(
      releaseMacos([...context.args, "--prepare-only"], context.dependencies),
    ).rejects.toThrow("RELEASE_SIGNATURE_VERIFICATION_FAILED");
    expect(context.verifications.some((entry) => entry.kind === "binary")).toBe(
      true,
    );
    expect(context.calls.some((call) => call.args[0] === "create")).toBe(false);
  });
  it("requires code_signed inventory flags to match the extracted Mach-O bytes", async () => {
    const context = await fixture();
    const changedManifest = structuredClone(context.runtimeManifest);
    const node = changedManifest.runtime.files.find(
      (entry) => entry.path === "runtime/runtime/node/bin/node",
    );
    const python = changedManifest.runtime.files.find(
      (entry) => entry.path === "runtime/runtime/python/bin/python3",
    );
    node!.code_signed = false;
    python!.code_signed = true;
    const manifestBytes = `${JSON.stringify(changedManifest, null, 2)}\n`;
    const manifestSha256 = createHash("sha256")
      .update(manifestBytes)
      .digest("hex");
    await writeFile(context.runtimeManifestPath, manifestBytes);
    await writeFile(
      join(context.app, "Contents/Resources/runtime-bootstrap.json"),
      manifestBytes,
    );
    await writeFile(
      context.packageResult,
      JSON.stringify({
        ...context.packaged,
        runtime: {
          ...context.packaged.runtime,
          manifest_sha256: manifestSha256,
        },
      }),
    );
    await expect(
      releaseMacos([...context.args, "--prepare-only"], context.dependencies),
    ).rejects.toThrow("RUNTIME_CODE_SIGNING_INVENTORY_MISMATCH");
  });
  it("does not upload an app with failed actual signature verification", async () => {
    const context = await fixture();
    context.behavior.failAppSignature = true;
    await expect(
      releaseMacos(
        [...context.args, "--keychain-profile", profile],
        context.dependencies,
      ),
    ).rejects.toThrow("RELEASE_SIGNATURE_VERIFICATION_FAILED");
    expect(context.calls.some((call) => call.args.includes("submit"))).toBe(
      false,
    );
  });
  it("requires both Apple acceptances, sanitizes logs and verifies the DMG while retaining external release gates", async () => {
    const context = await fixture();
    await writeFile(
      context.packageResult,
      JSON.stringify({
        ...context.packaged,
        clean_user_launch_tested: true,
        relocated_runtime_tested: true,
      }),
    );
    const result = await releaseMacos(
      [...context.args, "--keychain-profile", profile],
      context.dependencies,
    );
    expect(result).toMatchObject({
      state: "READY",
      public_ready: false,
      notarized: true,
      runtime_notarized: true,
      runtime_stapled: false,
      stapled: true,
      clean_user_launch_tested: false,
      relocated_runtime_tested: false,
    });
    expect(basename(result.dmg!)).toBe("MusicMute-0.1.0-arm64.dmg");
    const submitCalls = context.calls.filter(
      (call) => call.args[1] === "submit",
    );
    expect(submitCalls).toHaveLength(2);
    expect(submitCalls.map((call) => basename(call.args[2]!))).toEqual([
      expect.stringMatching(/^MusicMute-0\.1\.0-arm64-.*\.dmg$/),
      basename(context.runtimeArchive),
    ]);
    expect(result.runtime_submission_id).toBe(context.runtimeSubmissionId);
    expect(await readFile(result.runtime_zip!)).toEqual(
      await readFile(context.runtimeArchive),
    );
    expect(await readFile(result.runtime_manifest!, "utf8")).toBe(
      context.runtimeManifestBytes,
    );
    const submitCall = context.calls.find((call) => call.args[1] === "submit")!;
    expect(submitCall.args).toContain("--keychain-profile");
    expect(submitCall.args).not.toContain("--wait");
    expect(
      context.calls.filter((call) => call.file === "/usr/sbin/spctl"),
    ).toHaveLength(2);
    expect(
      context.verifications.some(
        (entry) => entry.path.includes("mount.noindex") && entry.kind === "app",
      ),
    ).toBe(true);
    expect(
      context.verifications.filter((entry) => entry.kind === "binary"),
    ).toHaveLength(1);
    expect(
      context.calls
        .filter(
          (call) =>
            call.file === "/usr/bin/xcrun" && call.args[0] === "stapler",
        )
        .every((call) => !call.args.includes(result.runtime_zip!)),
    ).toBe(true);
    expect(await readFile(result.dmg!, "utf8")).toBe(
      "signed DMG fixtureticket",
    );
    const record = await receipt(result.release_root);
    expect(record.state).toBe("READY");
    expect(record.public_ready).toBe(false);
    expect(record.runtime_submission_id).toBe(context.runtimeSubmissionId);
    expect(
      await readFile(
        join(result.release_root, String(record.filename)),
        "utf8",
      ),
    ).toBe("signed DMG fixture");
    const safe = await readFile(
      join(result.release_root, "notarization-log.json"),
      "utf8",
    );
    expect(safe).not.toContain("SECRET");
    expect(safe).not.toContain("ticketContents");
    expect(safe).not.toContain("account@example.test");
    const safeRuntime = await readFile(
      join(result.release_root, "runtime-notarization-log.json"),
      "utf8",
    );
    expect(safeRuntime).not.toContain("SECRET");
    expect(safeRuntime).toContain(context.runtimeSubmissionId);
    const again = await releaseMacos(
      resume(result.release_root, context.submissionId),
      context.dependencies,
    );
    expect(again.sha256).toBe(result.sha256);
    expect(
      context.calls.filter((call) => call.args[1] === "submit"),
    ).toHaveLength(2);
  });
  it("returns in-progress and resumes the same durable submission instead of uploading again", async () => {
    const context = await fixture();
    context.behavior.status = "In Progress";
    const first = await releaseMacos(
      [...context.args, "--keychain-profile", profile],
      context.dependencies,
    );
    expect(first).toMatchObject({
      state: "IN_PROGRESS",
      notarized: false,
      public_ready: false,
      submission_id: context.submissionId,
    });
    context.behavior.status = "Accepted";
    const second = await releaseMacos(
      resume(first.release_root, context.submissionId),
      context.dependencies,
    );
    expect(second).toMatchObject({ state: "READY", public_ready: false });
    expect(
      context.calls.filter((call) => call.args[1] === "submit"),
    ).toHaveLength(2);
    await expect(
      releaseMacos(submit(first.release_root), context.dependencies),
    ).rejects.toThrow("SUBMISSION_ALREADY_ATTEMPTED_USE_RESUME");
  });
  it("withholds stapling and readiness while the independent runtime submission is pending", async () => {
    const context = await fixture();
    context.behavior.status = "Accepted";
    context.behavior.runtimeStatus = "In Progress";
    const pending = await releaseMacos(
      [...context.args, "--keychain-profile", profile],
      context.dependencies,
    );
    expect(pending).toMatchObject({
      state: "IN_PROGRESS",
      submission_id: context.submissionId,
      runtime_submission_id: context.runtimeSubmissionId,
      runtime_notarized: false,
      public_ready: false,
    });
    expect(context.calls.some((call) => call.args.includes("stapler"))).toBe(
      false,
    );
    const pendingReceipt = await receipt(pending.release_root);
    expect(
      (
        pendingReceipt.notarization as {
          dmg: { state: string };
          runtime: { state: string };
        }
      ).dmg.state,
    ).toBe("ACCEPTED");
    expect(
      (
        pendingReceipt.notarization as {
          dmg: { state: string };
          runtime: { state: string };
        }
      ).runtime.state,
    ).toBe("IN_PROGRESS");

    context.behavior.runtimeStatus = "Accepted";
    const complete = await releaseMacos(
      resume(pending.release_root, context.runtimeSubmissionId),
      context.dependencies,
    );
    expect(complete).toMatchObject({
      state: "READY",
      notarized: true,
      runtime_notarized: true,
      public_ready: false,
    });
    expect(
      context.calls.filter((call) => call.args[1] === "submit"),
    ).toHaveLength(2);
  });
  it("never staples or publishes when Apple rejects the external runtime ZIP", async () => {
    const context = await fixture();
    context.behavior.status = "Accepted";
    context.behavior.runtimeStatus = "Rejected";
    await expect(
      releaseMacos(
        [...context.args, "--keychain-profile", profile],
        context.dependencies,
      ),
    ).rejects.toThrow("RUNTIME_NOTARIZATION_REJECTED_INSPECT_SANITIZED_LOG");
    expect(context.calls.some((call) => call.args.includes("stapler"))).toBe(
      false,
    );
    const releases = await readdir(join(context.root, "output/macos-release"));
    const directory = join(context.root, "output/macos-release", releases[0]!);
    const record = await receipt(directory);
    expect(record).toMatchObject({ state: "REJECTED", public_ready: false });
    const log = await readFile(
      join(directory, "runtime-notarization-log.json"),
      "utf8",
    );
    expect(log).toContain("SECURE_TIMESTAMP_REQUIRED");
    expect(log).not.toContain("SECRET");
  });
  it("fences an ambiguous runtime upload independently and binds only its recovered ID", async () => {
    const context = await fixture();
    const prepared = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    context.behavior.failRuntimeSubmit = true;
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow(
      "RUNTIME_NOTARIZATION_SUBMISSION_OUTCOME_UNKNOWN_USE_HISTORY_AND_RESUME",
    );
    const fenced = await receipt(prepared.release_root);
    expect(fenced).toMatchObject({
      submission_id: context.submissionId,
      runtime_submission_id: null,
      state: "SUBMITTING",
      public_ready: false,
    });
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow("SUBMISSION_ALREADY_ATTEMPTED_USE_RESUME");
    context.behavior.failRuntimeSubmit = false;
    const complete = await releaseMacos(
      resume(prepared.release_root, context.runtimeSubmissionId),
      context.dependencies,
    );
    expect(complete).toMatchObject({ state: "READY", public_ready: false });
    expect(complete.submission_id).toBe(context.submissionId);
    expect(complete.runtime_submission_id).toBe(context.runtimeSubmissionId);
    expect(
      context.calls.filter((call) => call.args[1] === "submit"),
    ).toHaveLength(2);
  });
  it.each(["Invalid", "Rejected"])(
    "never staples or publishes a %s submission",
    async (status) => {
      const context = await fixture();
      const prepared = await releaseMacos(
        [...context.args, "--prepare-only"],
        context.dependencies,
      );
      context.behavior.status = status;
      await expect(
        releaseMacos(submit(prepared.release_root), context.dependencies),
      ).rejects.toThrow("NOTARIZATION_REJECTED_INSPECT_SANITIZED_LOG");
      expect((await receipt(prepared.release_root)).state).toBe(
        status.toUpperCase(),
      );
      expect(context.calls.some((call) => call.args.includes("stapler"))).toBe(
        false,
      );
      expect(
        (await readdir(prepared.release_root)).includes("accepted.noindex"),
      ).toBe(false);
      const log = await readFile(
        join(prepared.release_root, "notarization-log.json"),
        "utf8",
      );
      expect(log).toContain("SECURE_TIMESTAMP_REQUIRED");
      expect(log).not.toContain("SECRET");
      expect(log).not.toContain("https://private.invalid");
    },
  );
  it.each(["failSubmit", "invalidSubmitJson"] as const)(
    "fences ambiguous upload after %s and permits only identified resume",
    async (failure) => {
      const context = await fixture();
      const prepared = await releaseMacos(
        [...context.args, "--prepare-only"],
        context.dependencies,
      );
      context.behavior[failure] = true;
      await expect(
        releaseMacos(submit(prepared.release_root), context.dependencies),
      ).rejects.toThrow(
        "NOTARIZATION_SUBMISSION_OUTCOME_UNKNOWN_USE_HISTORY_AND_RESUME",
      );
      expect((await receipt(prepared.release_root)).state).toBe("SUBMITTING");
      await expect(
        releaseMacos(submit(prepared.release_root), context.dependencies),
      ).rejects.toThrow("SUBMISSION_ALREADY_ATTEMPTED_USE_RESUME");
      context.behavior[failure] = false;
      const resumed = await releaseMacos(
        resume(prepared.release_root, context.submissionId),
        context.dependencies,
      );
      expect(resumed).toMatchObject({ state: "READY", public_ready: false });
      expect(
        context.calls.filter((call) => call.args[1] === "submit"),
      ).toHaveLength(2);
      expect(
        await readFile(
          join(prepared.release_root, "notarization-receipt.json"),
          "utf8",
        ),
      ).not.toContain("SECRET");
    },
  );
  it("leaves ambiguous ID unbound if Apple's unique image name does not match", async () => {
    const context = await fixture();
    const prepared = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    context.behavior.failSubmit = true;
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow("OUTCOME_UNKNOWN");
    context.behavior.wrongInfoName = true;
    await expect(
      releaseMacos(
        resume(prepared.release_root, randomUUID()),
        context.dependencies,
      ),
    ).rejects.toThrow("NOTARIZATION_STATUS_MISMATCH");
    expect((await receipt(prepared.release_root)).submission_id).toBeNull();
  });
  it.each(["failDmgAssessment", "failAppAssessment", "failStaple"] as const)(
    "withholds the final artifact when %s fails, then resumes without a new upload",
    async (failure) => {
      const context = await fixture();
      const prepared = await releaseMacos(
        [...context.args, "--prepare-only"],
        context.dependencies,
      );
      context.behavior[failure] = true;
      await expect(
        releaseMacos(submit(prepared.release_root), context.dependencies),
      ).rejects.toThrow(
        failure === "failStaple"
          ? "DMG_STAPLING_FAILED_RESUME_SAME_SUBMISSION"
          : failure === "failAppAssessment"
            ? "APP_GATEKEEPER_REJECTED"
            : "DMG_GATEKEEPER_REJECTED",
      );
      expect((await receipt(prepared.release_root)).public_ready).toBe(false);
      expect(
        (await readdir(prepared.release_root)).includes("accepted.noindex"),
      ).toBe(false);
      context.behavior[failure] = false;
      expect(
        await releaseMacos(
          resume(prepared.release_root, context.submissionId),
          context.dependencies,
        ),
      ).toMatchObject({ state: "READY", public_ready: false });
      expect(
        context.calls.filter((call) => call.args[1] === "submit"),
      ).toHaveLength(2);
    },
  );
  it("requires original image bytes to match the uploaded hash on resume", async () => {
    const context = await fixture();
    context.behavior.status = "In Progress";
    const pending = await releaseMacos(
      [...context.args, "--keychain-profile", profile],
      context.dependencies,
    );
    const record = await receipt(pending.release_root);
    await appendFile(
      join(pending.release_root, String(record.filename)),
      "tampered",
    );
    await expect(
      releaseMacos(
        resume(pending.release_root, context.submissionId),
        context.dependencies,
      ),
    ).rejects.toThrow("RELEASE_IMAGE_CHANGED");
    expect(
      context.calls.filter((call) => call.args[1] === "info"),
    ).toHaveLength(2);
  });
  it.each(["wrongLogHash", "missingLogHash"] as const)(
    "never uses an accepted Apple log with %s as readiness evidence",
    async (failure) => {
      const context = await fixture();
      context.behavior[failure] = true;
      await expect(
        releaseMacos(
          [...context.args, "--keychain-profile", profile],
          context.dependencies,
        ),
      ).rejects.toThrow("NOTARIZATION_LOG_MISMATCH");
      expect(context.calls.some((call) => call.args.includes("stapler"))).toBe(
        false,
      );
    },
  );
  it("re-reads the receipt under the exclusive lock before uploading", async () => {
    const context = await fixture();
    const prepared = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    const resolveConfiguration =
      context.dependencies.signing.resolveSigningConfiguration;
    context.dependencies.signing.resolveSigningConfiguration = async () => {
      const current = await receipt(prepared.release_root);
      await writeFile(
        join(prepared.release_root, "notarization-receipt.json"),
        JSON.stringify({
          ...current,
          state: "SUBMITTING",
          submission_authorized_at: new Date().toISOString(),
          notarization: {
            ...(current.notarization as Record<string, unknown>),
            dmg: {
              ...(
                current.notarization as {
                  dmg: Record<string, unknown>;
                }
              ).dmg,
              state: "SUBMITTING",
            },
          },
        }),
      );
      return resolveConfiguration();
    };
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow("SUBMISSION_ALREADY_ATTEMPTED_USE_RESUME");
    expect(context.calls.some((call) => call.args.includes("submit"))).toBe(
      false,
    );
    expect((await receipt(prepared.release_root)).state).toBe("SUBMITTING");
  });
  it("refuses a live release lock instead of racing an upload", async () => {
    const context = await fixture();
    const prepared = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    await writeFile(
      join(prepared.release_root, ".release-lock.json"),
      JSON.stringify({ pid: process.pid }),
      { mode: 0o600 },
    );
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow("RELEASE_ALREADY_RUNNING");
    expect(context.calls.some((call) => call.args.includes("submit"))).toBe(
      false,
    );
  });
  it("refuses writable release records without fixing their permissions", async () => {
    const context = await fixture();
    const prepared = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    const path = join(prepared.release_root, "notarization-receipt.json");
    await chmod(path, 0o666);
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow("UNSAFE_RELEASE_PATH");
    expect((await lstat(path)).mode & 0o777).toBe(0o666);
  });
  it("cleans the exact owned partial mount after attach timed out, then resumes without another upload", async () => {
    const context = await fixture();
    const prepared = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    context.behavior.attachTimeoutAfterMount = true;
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow("DMG_MOUNT_FAILED");
    expect(context.mountedImages.size).toBe(0);
    await expect(
      lstat(join(prepared.release_root, "mount.noindex")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    context.behavior.attachTimeoutAfterMount = false;
    expect(
      await releaseMacos(
        resume(prepared.release_root, context.submissionId),
        context.dependencies,
      ),
    ).toMatchObject({ state: "READY", public_ready: false });
    expect(
      context.calls.filter((call) => call.args[1] === "submit"),
    ).toHaveLength(2);
    expect(
      context.calls
        .filter((call) => call.args[0] === "detach")
        .every((call) => call.args[1] === "/dev/disk999s1"),
    ).toBe(true);
  });
  it("recovers a failed detach only after recorded image hash and signature checks", async () => {
    const context = await fixture();
    const prepared = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    context.behavior.failDetach = true;
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow("DMG_DETACH_FAILED");
    expect(context.mountedImages.size).toBe(1);
    expect((await receipt(prepared.release_root)).public_ready).toBe(false);
    context.behavior.failDetach = false;
    const previousVerifications = context.verifications.length;
    expect(
      await releaseMacos(
        resume(prepared.release_root, context.submissionId),
        context.dependencies,
      ),
    ).toMatchObject({ state: "READY", public_ready: false });
    expect(context.mountedImages.size).toBe(0);
    expect(
      context.verifications
        .slice(previousVerifications)
        .some(
          (entry) => entry.kind === "dmg" && entry.path.includes("stapled-"),
        ),
    ).toBe(true);
    expect(
      context.calls.filter((call) => call.args[1] === "submit"),
    ).toHaveLength(2);
    expect(
      (await readdir(prepared.release_root)).some((name) =>
        name.startsWith(".mount-inspection-"),
      ),
    ).toBe(false);
  });
  it("never detaches a different image occupying the old release mountpoint", async () => {
    const context = await fixture();
    const prepared = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    context.behavior.failDetach = true;
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow("DMG_DETACH_FAILED");
    const mount = join(prepared.release_root, "mount.noindex");
    context.mountedImages.set(mount, {
      image: "/private/unrelated-secret-image.dmg",
      device: "/dev/disk997s1",
    });
    context.behavior.failDetach = false;
    const detachesBefore = context.calls.filter(
      (call) => call.args[0] === "detach",
    ).length;
    await expect(
      releaseMacos(
        resume(prepared.release_root, context.submissionId),
        context.dependencies,
      ),
    ).rejects.toThrow("DMG_MOUNT_IMAGE_MISMATCH");
    expect(
      context.calls.filter((call) => call.args[0] === "detach"),
    ).toHaveLength(detachesBefore);
    expect(
      await readFile(
        join(mount, "MusicMute Local.app/Contents/Info.plist"),
        "utf8",
      ),
    ).toBe("fixture plist");
    expect(context.mountedImages.get(mount)?.image).toBe(
      "/private/unrelated-secret-image.dmg",
    );
    expect(
      await readFile(
        join(prepared.release_root, "notarization-receipt.json"),
        "utf8",
      ),
    ).not.toContain("unrelated-secret-image");
  });
  it("refuses to detach when the recorded working image was modified", async () => {
    const context = await fixture();
    const prepared = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    context.behavior.failDetach = true;
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow("DMG_DETACH_FAILED");
    const mount = join(prepared.release_root, "mount.noindex");
    const working = context.mountedImages.get(mount)!.image;
    await appendFile(working, "tampered");
    context.behavior.failDetach = false;
    const detachesBefore = context.calls.filter(
      (call) => call.args[0] === "detach",
    ).length;
    await expect(
      releaseMacos(
        resume(prepared.release_root, context.submissionId),
        context.dependencies,
      ),
    ).rejects.toThrow("DMG_MOUNT_IMAGE_UNVERIFIED");
    expect(
      context.calls.filter((call) => call.args[0] === "detach"),
    ).toHaveLength(detachesBefore);
    expect(await readFile(working, "utf8")).toContain("tampered");
  });
  it("keeps unknown contents in an unregistered leftover mount directory", async () => {
    const context = await fixture();
    const prepared = await releaseMacos(
      [...context.args, "--prepare-only"],
      context.dependencies,
    );
    const mount = join(prepared.release_root, "mount.noindex");
    await mkdir(mount, { mode: 0o700 });
    await writeFile(join(mount, "unknown-owned-fixture"), "retained bytes");
    await expect(
      releaseMacos(submit(prepared.release_root), context.dependencies),
    ).rejects.toThrow("DMG_MOUNT_DIRECTORY_NOT_EMPTY");
    expect(await readFile(join(mount, "unknown-owned-fixture"), "utf8")).toBe(
      "retained bytes",
    );
    expect(context.calls.some((call) => call.args[0] === "detach")).toBe(false);
  });
});

describe("bounded safe notarization diagnostics", () => {
  it("projects known signing issues without unknown fields, URLs, emails or raw messages", () => {
    const id = randomUUID();
    const filename = "MusicMute-fixture.dmg";
    const projected = sanitizeNotaryLog(
      {
        jobId: id.toUpperCase(),
        archiveFilename: filename,
        sha256: "a".repeat(64),
        status: "Invalid",
        privateUnknown: "SECRET",
        issues: Array.from({ length: 140 }, () => ({
          severity: "error",
          code: 4000,
          path: "/private/secret/MusicMute Local.app/Contents/MacOS/MusicMuteLocal",
          message:
            "hardened runtime missing SECRET private@example.test https://private.invalid/key",
          architecture: "arm64",
        })),
      },
      { id, filename, sha256: "a".repeat(64) },
    );
    expect(projected.issue_count).toBe(140);
    expect(projected.issues_truncated).toBe(true);
    expect(projected.issues).toHaveLength(128);
    const text = JSON.stringify(projected);
    expect(text).toContain("HARDENED_RUNTIME_REQUIRED");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("/private/secret");
    expect(text).not.toContain("private@example.test");
    expect(text).not.toContain("https://");
  });
});
