import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appFixture,
  borrowedAppModel,
  digest,
} from "./fixtures/app-service.js";
import {
  macAppServiceCandidateIdentity,
  publishMacAppRuntimeReference,
  readAppBinding,
  reconcileMacAppRuntimeReferences,
  resolveMacAppExecutionLayout,
  stageMacAppService,
  verifyAppServiceNativeCode,
  verifyAppServicePayload,
  verifyManagedMacRelease,
} from "../src/platform/macos/app-installation-binding.js";
import { activateMacUserRelease } from "../src/platform/macos/user-release.js";
import {
  renderLaunchAgentPlist,
  writeLaunchAgentPlist,
} from "../src/platform/macos/launch-agent.js";
import type { AppServiceManifest } from "../src/platform/macos/app-installation-binding.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const execute = promisify(execFile);
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "musicmute-app-binding-")),
  );
  roots.push(root);
  return await appFixture(root);
}

describe.skipIf(!existsSync(borrowedAppModel))(
  "explicit external runtime binding with isolated state",
  () => {
    it("fully verifies the service/shared base/model and publishes an exact durable consumer", async () => {
      const f = await fixture();
      const staged = await stageMacAppService(f.layout, f.resources, f.support);
      expect(
        (await verifyManagedMacRelease(staged.releaseRoot)).schemaVersion,
      ).toBe(2);
      expect(
        await lstat(join(staged.releaseRoot, "app", "engine")),
      ).toBeDefined();
      await expect(
        lstat(join(staged.releaseRoot, "runtime")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await activateMacUserRelease(f.layout, staged.releaseVersion);
      const layout = await resolveMacAppExecutionLayout(f.layout);
      expect(layout.pythonPath).toBe(
        join(f.release, "runtime", "runtime", "python", "bin", "python3"),
      );
      expect(layout.modelRoot).toBe(join(f.support, "models"));
      expect(renderLaunchAgentPlist(layout)).toContain(layout.nodePath);
      const reference = JSON.parse(
        await readFile(
          join(f.support, "runtime", "consumers", `${staged.serviceId}.json`),
          "utf8",
        ),
      );
      expect(reference).toEqual({
        schema_version: 1,
        consumer: "macos-worker",
        runtime_id: f.runtimeId,
        archive_sha256: "a".repeat(64),
        worker_root: f.layout.installRoot,
        service_id: staged.serviceId,
      });
      expect(
        (
          await lstat(
            join(f.support, "runtime", "consumers", `${staged.serviceId}.json`),
          )
        ).mode & 0o077,
      ).toBe(0);
      await writeLaunchAgentPlist(f.layout, {
        fixturePath: join(f.layout.stateRoot, "qualification.wav"),
        fixtureSha256: "b".repeat(64),
        reportPath: join(f.layout.stateRoot, "qualification.json"),
        releaseRoot: staged.releaseRoot,
      });
      expect(await readFile(f.layout.plistPath, "utf8")).toContain(
        layout.pythonPath,
      );
    });

    it("reuses immutable code, and app update check does not stage another release", async () => {
      const f = await fixture();
      const before = await macAppServiceCandidateIdentity(f.resources);
      const staged = await stageMacAppService(f.layout, f.resources, f.support);
      expect(staged.releaseVersion).toBe(before.releaseVersion);
      expect(staged.serviceId).toBe(before.serviceId);
      expect(
        (await stageMacAppService(f.layout, f.resources, f.support)).reused,
      ).toBe(true);
      await writeFile(
        join(staged.releaseRoot, "app", "package.json"),
        '{"version":"evil"}',
        { mode: 0o644 },
      );
      await expect(
        stageMacAppService(f.layout, f.resources, f.support),
      ).rejects.toThrow("inventory changed");
    });

    it("stages a distinct immutable binding when only the runtime delivery policy changes", async () => {
      const f = await fixture();
      const previous = await stageMacAppService(
        f.layout,
        f.resources,
        f.support,
      );
      const previousBytes = await readFile(
        join(previous.releaseRoot, "release-manifest.json"),
      );
      const previousBinding = (await readAppBinding(previous.releaseRoot))!;
      const bootstrapPath = join(f.resources, "runtime-bootstrap.json");
      const bootstrap = JSON.parse(await readFile(bootstrapPath, "utf8"));
      await writeFile(
        bootstrapPath,
        JSON.stringify({
          ...bootstrap,
          runtime: {
            ...bootstrap.runtime,
            url: "https://runtime.music-mute.com/approved-runtime.zip",
            download_hosts: ["runtime.music-mute.com"],
          },
        }),
        { mode: 0o644 },
      );
      const candidate = await macAppServiceCandidateIdentity(f.resources);
      expect(candidate.serviceId).not.toBe(previous.serviceId);
      const staged = await stageMacAppService(f.layout, f.resources, f.support);
      expect(staged.releaseVersion).toBe(candidate.releaseVersion);
      expect(staged.releaseVersion).not.toBe(previous.releaseVersion);
      expect(staged.reused).toBe(false);
      const binding = (await readAppBinding(staged.releaseRoot))!;
      expect(binding.payloadSha256).toBe(previousBinding.payloadSha256);
      expect(binding.base.runtimeId).toBe(previousBinding.base.runtimeId);
      expect(binding.base.archiveSha256).toBe(
        previousBinding.base.archiveSha256,
      );
      expect(binding.base.bootstrapSha256).not.toBe(
        previousBinding.base.bootstrapSha256,
      );
      expect(await verifyManagedMacRelease(previous.releaseRoot)).toEqual(
        previousBinding,
      );
      expect(
        await readFile(join(previous.releaseRoot, "release-manifest.json")),
      ).toEqual(previousBytes);
      expect(
        (await stageMacAppService(f.layout, f.resources, f.support)).reused,
      ).toBe(true);
    });

    it("preserves verification and immutable bytes of older schema2 release names", async () => {
      const f = await fixture();
      const staged = await stageMacAppService(f.layout, f.resources, f.support);
      const binding = (await readAppBinding(staged.releaseRoot))!;
      const oldVersion = `0.1.3-app.${binding.payloadSha256.slice(0, 12)}.${digest(Buffer.from(binding.base.runtimeId + binding.base.archiveSha256)).slice(0, 12)}`;
      const oldRoot = join(f.layout.releasesRoot, oldVersion);
      const oldBinding = { ...binding, releaseVersion: oldVersion };
      const oldBytes = Buffer.from(`${JSON.stringify(oldBinding)}\n`);
      await rename(staged.releaseRoot, oldRoot);
      await writeFile(join(oldRoot, "release-manifest.json"), oldBytes, {
        mode: 0o600,
      });
      expect(await verifyManagedMacRelease(oldRoot)).toEqual(oldBinding);
      await activateMacUserRelease(f.layout, oldVersion);
      expect((await resolveMacAppExecutionLayout(f.layout)).cliPath).toBe(
        join(oldRoot, "app", "dist", "src", "cli", "main.js"),
      );
      const candidate = await macAppServiceCandidateIdentity(f.resources);
      const current = await stageMacAppService(
        f.layout,
        f.resources,
        f.support,
      );
      expect(current.releaseVersion).toBe(candidate.releaseVersion);
      expect(current.releaseVersion).not.toBe(oldVersion);
      expect(current.serviceId).toBe(binding.serviceId);
      expect(await verifyManagedMacRelease(oldRoot)).toEqual(oldBinding);
      expect(await readFile(join(oldRoot, "release-manifest.json"))).toEqual(
        oldBytes,
      );
    });

    it("releases only unused owned runtime refs and rejects malformed refs before purge", async () => {
      const f = await fixture();
      const staged = await stageMacAppService(f.layout, f.resources, f.support);
      await publishMacAppRuntimeReference(f.layout, staged.releaseRoot);
      const reference = join(
        f.support,
        "runtime",
        "consumers",
        `${staged.serviceId}.json`,
      );
      await reconcileMacAppRuntimeReferences(f.layout);
      await expect(lstat(reference)).resolves.toBeDefined();
      const bad = join(
        f.support,
        "runtime",
        "consumers",
        `${"f".repeat(64)}.json`,
      );
      await writeFile(bad, "{}", { mode: 0o600 });
      await expect(
        reconcileMacAppRuntimeReferences(f.layout, true),
      ).rejects.toThrow("invalid");
      await expect(lstat(reference)).resolves.toBeDefined();
      await rm(bad);
      await rm(staged.releaseRoot, { recursive: true });
      await reconcileMacAppRuntimeReferences(f.layout);
      await expect(lstat(reference)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects corrupted shared bytes, extra directories and foreign/symlink bindings", async () => {
      const f = await fixture();
      const staged = await stageMacAppService(f.layout, f.resources, f.support);
      await mkdir(join(f.release, "runtime", "unexpected"), { mode: 0o700 });
      await expect(verifyManagedMacRelease(staged.releaseRoot)).rejects.toThrow(
        "undeclared directory",
      );
      await rm(join(f.release, "runtime", "unexpected"), { recursive: true });
      const python = join(
        f.release,
        "runtime",
        "runtime",
        "python",
        "bin",
        "python3",
      );
      await writeFile(python, "changed", { mode: 0o755 });
      await expect(verifyManagedMacRelease(staged.releaseRoot)).rejects.toThrow(
        "file changed",
      );
      const binding = (await readAppBinding(staged.releaseRoot))!;
      await writeFile(
        join(staged.releaseRoot, "release-manifest.json"),
        JSON.stringify({
          ...binding,
          base: {
            ...binding.base,
            supportRoot: join(
              f.home,
              "foreign",
              "Library",
              "Application Support",
              "MusicMuteLocal",
            ),
          },
        }),
        { mode: 0o600 },
      );
      await expect(readAppBinding(staged.releaseRoot)).rejects.toThrow(
        "escapes",
      );
      await rm(join(staged.releaseRoot, "release-manifest.json"));
      await symlink(
        join(f.resources, "runtime-bootstrap.json"),
        join(staged.releaseRoot, "release-manifest.json"),
      );
      await expect(readAppBinding(staged.releaseRoot)).rejects.toThrow(
        "metadata is unsafe",
      );
    });

    it.skipIf(process.platform !== "darwin")(
      "materializes exact compressed code and reuses it across ZIP transport metadata changes",
      async () => {
        const f = await fixture();
        const archive = join(f.source, "service-payload.zip");
        await execute("/usr/bin/zip", ["-q", "-r", "-y", archive, "app"], {
          cwd: f.source,
        });
        const bytes = await readFile(archive);
        await writeFile(
          join(f.source, "archive.json"),
          JSON.stringify({
            schema_version: 1,
            filename: "service-payload.zip",
            bytes: bytes.length,
            sha256: digest(bytes),
          }),
          { mode: 0o644 },
        );
        await rm(join(f.source, "app"), { recursive: true });
        const staged = await stageMacAppService(
          f.layout,
          f.resources,
          f.support,
        );
        expect(await verifyManagedMacRelease(staged.releaseRoot)).toMatchObject(
          { distribution: "app-external" },
        );
        await publishMacAppRuntimeReference(f.layout, staged.releaseRoot);
        // An archive comment changes transport bytes without changing a file
        // in the verified app inventory or either immutable manifest.
        expect(bytes.readUInt16LE(bytes.length - 2)).toBe(0);
        const comment = Buffer.from("rebuilt transport metadata");
        const rebuilt = Buffer.concat([bytes, comment]);
        rebuilt.writeUInt16LE(comment.length, bytes.length - 2);
        expect(digest(rebuilt)).not.toBe(digest(bytes));
        await writeFile(archive, rebuilt, { mode: 0o644 });
        await writeFile(
          join(f.source, "archive.json"),
          JSON.stringify({
            schema_version: 1,
            filename: "service-payload.zip",
            bytes: rebuilt.length,
            sha256: digest(rebuilt),
          }),
          { mode: 0o644 },
        );
        expect(
          await stageMacAppService(f.layout, f.resources, f.support),
        ).toEqual({ ...staged, reused: true });
      },
    );
  },
);

it("checks every native addon/magic file against the same signing policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-app-native-"));
  roots.push(root);
  await mkdir(join(root, "app"), { mode: 0o700 });
  await writeFile(
    join(root, "app", "addon.node"),
    Buffer.from("cffaedfe01020304", "hex"),
  );
  const entries = [
    {
      path: "app/addon.node",
      kind: "file" as const,
      bytes: 8,
      mode: 0o644,
      sha256: "a".repeat(64),
    },
  ];
  const manifest: AppServiceManifest = {
    schema_version: 1,
    platform: "darwin",
    architecture: "arm64",
    worker_version: "0.1.3",
    api_version: 1,
    entries,
    payload_sha256: "b".repeat(64),
  };
  const verifier = vi.fn(async () => undefined);
  await verifyAppServiceNativeCode(
    root,
    manifest,
    { mode: "developer_id", team_id: "ABCDEFGHIJ" },
    verifier,
  );
  expect(verifier).toHaveBeenCalledWith(join(root, "app", "addon.node"), {
    mode: "developer_id",
    team_id: "ABCDEFGHIJ",
  });
  verifier.mockRejectedValue(new Error("wrong signature"));
  await expect(
    verifyAppServiceNativeCode(root, manifest, { mode: "ad_hoc" }, verifier),
  ).rejects.toThrow("wrong signature");
  await writeFile(join(root, "app", "addon.node"), "ELF");
  await expect(
    verifyAppServiceNativeCode(root, manifest, { mode: "ad_hoc" }, verifier),
  ).rejects.toThrow("target is invalid");
});

it("accepts the real packaging producer's canonical inventory including uppercase LICENSE", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "musicmute-app-producer-")),
  );
  roots.push(root);
  const workerRoot = join(root, "worker");
  const files = [
    "dist/src/cli/main.js",
    "dist/src/cli/app-control.js",
    "dist/src/agent/process-guardian.js",
    "dist/src/runtime/worker-runtime.js",
    "dist/src/runtime/personal-admission.js",
    "dist/protocol/v1/protocol.js",
    ...[
      "__main__",
      "service_doctor",
      "qualification",
      "pipeline",
      "separator",
      "child",
      "capacity_benchmark",
    ].map((name) => `engine/musicmute_engine/${name}.py`),
    "LICENSE",
  ];
  for (const file of files) {
    const path = join(workerRoot, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "fixture", { mode: 0o644 });
  }
  await writeFile(
    join(workerRoot, "package.json"),
    JSON.stringify({
      name: "@music-mute/worker",
      version: "0.1.3",
      type: "module",
      dependencies: {},
    }),
    { mode: 0o644 },
  );
  const producerPath = new URL(
    "../../chrome-extension/scripts/worker-service-artifact.mjs",
    import.meta.url,
  ).href;
  const { stageWorkerService } = await import(producerPath);
  const outputRoot = join(root, "service");
  const produced = await stageWorkerService({
    workerRoot,
    outputRoot,
    installDependencies: async () => undefined,
  });
  expect((await verifyAppServicePayload(outputRoot)).entries).toEqual(
    produced.entries,
  );
  expect(produced.entries[1].path).toBe("app/LICENSE");
});

it.skipIf(!process.env.MUSICMUTE_TEST_SERVICE_PAYLOAD)(
  "verifies a supplied real signed packaging payload",
  async () => {
    const source = process.env.MUSICMUTE_TEST_SERVICE_PAYLOAD!;
    const manifest = await verifyAppServicePayload(source);
    await verifyAppServiceNativeCode(source, manifest, { mode: "ad_hoc" });
  },
);
