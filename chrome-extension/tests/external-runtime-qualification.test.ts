import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];

type RuntimeArtifact = {
  id: string;
  api_version: number;
  source_version: string;
  archive: string;
  archive_bytes: number;
  archive_sha256: string;
  installed_bytes: number;
  manifest: string;
  manifest_sha256: string;
  url: string;
  files: number;
  native_binaries: number;
  reused: boolean;
  signing: { mode: "ad_hoc" };
};

type QualificationModule = {
  stageExternalRuntimeForQualification(options: {
    app: string;
    stateRoot: string;
    exec: typeof run;
  }): Promise<{
    resources: string;
    runtimeRoot: string;
    releaseRoot: string;
    activePath: string;
    runtime: { id: string; archive_sha256: string };
    packageResult: unknown;
  }>;
  verifyExternalRuntimeForQualification(options: {
    releaseRoot: string;
    activePath: string;
    runtime: unknown;
    packageResult: unknown;
    exec: typeof run;
  }): Promise<unknown>;
};

const artifactModule = (await import(
  new URL("../scripts/macos-runtime-artifact.mjs", import.meta.url).href
)) as {
  createMacRuntimeArtifact(options: {
    releaseRoot: string;
    outputDirectory: string;
    downloadBaseURL: string;
    sourceVersion: string;
    signing: { release: false; identity: "-"; signing: "AD_HOC_LOCAL" };
    signatureVerifier: () => Promise<void>;
  }): Promise<RuntimeArtifact>;
};
const qualification = (await import(
  new URL("../scripts/external-runtime-qualification.mjs", import.meta.url).href
)) as QualificationModule;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await run("/bin/chmod", ["-R", "u+rwX", root]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function fixture(segmented = false): Promise<{
  app: string;
  state: string;
  manifest: string;
  runtime: RuntimeArtifact;
  nativeBinaries: number;
}> {
  const temporary = await realpath(tmpdir());
  const parent = await mkdtemp(
    join(temporary, "musicmute-runtime-qualification-"),
  );
  roots.push(parent);
  const buildId = randomUUID();
  const buildRoot = join(parent, `build-${buildId}.noindex`);
  const app = join(buildRoot, "MusicMute Local.app");
  const resources = join(app, "Contents/Resources");
  const release = join(parent, "runtime-source.noindex");
  await mkdir(resources, { recursive: true, mode: 0o700 });
  await mkdir(release, { mode: 0o700 });
  const paths = [
    "runtime/runtime/node/bin/node",
    "runtime/runtime/python/bin/python3",
    "runtime/runtime/bin/ffmpeg",
    "runtime/runtime/bin/ffprobe",
    "runtime/tools/youtube/bin/deno",
  ];
  const header = Buffer.from("cffaedfe", "hex");
  for (const path of paths) {
    const destination = join(release, path);
    await mkdir(join(destination, ".."), { recursive: true, mode: 0o755 });
    await writeFile(destination, Buffer.concat([header, Buffer.from(path)]), {
      mode: 0o755,
    });
  }
  await mkdir(join(release, "runtime/runtime/licenses"), { mode: 0o755 });
  await writeFile(
    join(release, "runtime/runtime/licenses/NOTICE.txt"),
    "notice\n",
    {
      mode: 0o644,
    },
  );
  await symlink("node", join(release, "runtime/runtime/node/bin/node-link"));
  await symlink("bin", join(release, "runtime/runtime/node/bin-current"));
  await symlink(
    "bin-current",
    join(release, "runtime/runtime/node/bin-active"),
  );
  const runtime = await artifactModule.createMacRuntimeArtifact({
    releaseRoot: release,
    outputDirectory: join(buildRoot, "runtime-release.noindex"),
    downloadBaseURL: "https://downloads.example.test/musicmute/runtime/",
    sourceVersion: "0.1.0",
    signing: { release: false, identity: "-", signing: "AD_HOC_LOCAL" },
    signatureVerifier: async () => {},
  });
  await copyFile(runtime.manifest, join(resources, "runtime-bootstrap.json"));
  const manifestDocument = JSON.parse(await readFile(runtime.manifest, "utf8"));
  const nativeBinaries = manifestDocument.runtime.files.filter(
    (entry: { code_signed?: boolean }) => entry.code_signed === true,
  ).length;
  let components:
    | {
        id: string;
        url: string;
        archive: string;
        archive_bytes: number;
        archive_sha256: string;
        file_paths: string[];
      }[]
    | undefined;
  if (segmented) {
    const componentModule = (await import(
      new URL("../scripts/macos-runtime-components.mjs", import.meta.url).href
    )) as {
      runtimeComponentForPath(path: string): string;
      validateRuntimeComponents(value: unknown): void;
    };
    const entries = manifestDocument.runtime.files as { path: string }[];
    const ids = [
      ...new Set(
        entries.map((entry) =>
          componentModule.runtimeComponentForPath(entry.path),
        ),
      ),
    ];
    components = [];
    for (const id of ids) {
      const file_paths = entries
        .filter(
          (entry) => componentModule.runtimeComponentForPath(entry.path) === id,
        )
        .map((entry) => entry.path);
      const archive = join(dirname(runtime.manifest), id + ".zip");
      await run(
        "/usr/bin/zip",
        ["-q", "-X", "-D", "-y", archive, ...file_paths],
        { cwd: release },
      );
      await chmod(archive, 0o600);
      components.push({
        id,
        url: "https://downloads.example.test/musicmute/runtime/" + id + ".zip",
        archive,
        archive_bytes: (await lstat(archive)).size,
        archive_sha256: await digest(archive),
        file_paths,
      });
    }
    const declared = components.map(
      ({ archive: _archive, ...component }) => component,
    );
    manifestDocument.runtime.components = declared;
    manifestDocument.runtime.archive_format = "zip-components";
    runtime.archive_bytes = components.reduce(
      (sum, component) => sum + component.archive_bytes,
      0,
    );
    runtime.archive_sha256 = createHash("sha256")
      .update(
        components.map((component) => component.archive_sha256).join("\n") +
          "\n",
      )
      .digest("hex");
    manifestDocument.runtime.archive_bytes = runtime.archive_bytes;
    manifestDocument.runtime.archive_sha256 = runtime.archive_sha256;
    componentModule.validateRuntimeComponents(manifestDocument.runtime);
    await writeFile(runtime.manifest, JSON.stringify(manifestDocument), {
      mode: 0o600,
    });
    await copyFile(runtime.manifest, join(resources, "runtime-bootstrap.json"));
    runtime.manifest_sha256 = await digest(runtime.manifest);
  }
  const result = {
    schema_version: 1,
    build_id: buildId,
    app,
    build_root: buildRoot,
    signing: "AD_HOC_LOCAL",
    release_mode: false,
    public_ready: false,
    runtime: {
      delivery: "EXTERNAL_PREPARE",
      ...runtime,
      ...(components ? { components } : {}),
      native_binaries: nativeBinaries,
      notarized: false,
      public_ready: false,
    },
  };
  await writeFile(
    join(buildRoot, "package-result.json"),
    `${JSON.stringify(result)}\n`,
    { mode: 0o600 },
  );
  const state = join(parent, "qualification-state.noindex");
  await mkdir(state, { mode: 0o700 });
  return { app, state, manifest: runtime.manifest, runtime, nativeBinaries };
}

const verifiedExec = (async (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => {
  if (file === "/usr/bin/codesign")
    return {
      stdout: "",
      stderr: args.includes("-d")
        ? "Signature=adhoc\nTeamIdentifier=not set\nflags=0x10000(runtime)\n"
        : "",
    };
  return run(file, args, options);
}) as typeof run;

describe("external runtime qualification staging", () => {
  it("assembles and verifies separate component archives using the sealed inventory", async () => {
    const { app, state, runtime, nativeBinaries } = await fixture(true);
    const staged = await qualification.stageExternalRuntimeForQualification({
      app,
      stateRoot: state,
      exec: verifiedExec,
    });
    expect(staged.runtime).toMatchObject({
      id: runtime.id,
      archive_format: "zip-components",
    });
    const verified = (await qualification.verifyExternalRuntimeForQualification(
      {
        releaseRoot: staged.releaseRoot,
        activePath: staged.activePath,
        runtime: staged.runtime,
        packageResult: staged.packageResult,
        exec: verifiedExec,
      },
    )) as { files: { code_signed?: boolean }[] };
    expect(
      verified.files.filter((file) => file.code_signed === true),
    ).toHaveLength(nativeBinaries);
  });
  it("verifies and stages the exact thin-package runtime in disposable state", async () => {
    const { app, state, runtime, nativeBinaries } = await fixture();
    const staged = await qualification.stageExternalRuntimeForQualification({
      app,
      stateRoot: state,
      exec: verifiedExec,
    });

    expect(staged.runtime).toMatchObject({
      id: runtime.id,
      archive_sha256: runtime.archive_sha256,
    });
    expect(JSON.parse(await readFile(staged.activePath, "utf8"))).toStrictEqual(
      {
        api_version: 1,
        archive_sha256: runtime.archive_sha256,
        release_path: `releases/${runtime.id}`,
        runtime_id: runtime.id,
        schema_version: 1,
      },
    );
    expect((await lstat(staged.activePath)).mode & 0o777).toBe(0o400);
    const bootstrapLock = join(staged.activePath, "..", "bootstrap.lock");
    expect((await lstat(bootstrapLock)).mode & 0o777).toBe(0o600);
    expect((await lstat(bootstrapLock)).size).toBe(0);
    expect((await lstat(staged.releaseRoot)).mode & 0o777).toBe(0o500);
    expect(
      (await lstat(join(staged.runtimeRoot, "runtime/node/bin/node"))).mode &
        0o777,
    ).toBe(0o500);
    expect(
      await readlink(join(staged.runtimeRoot, "runtime/node/bin-current")),
    ).toBe("bin");
    expect(
      await readlink(join(staged.runtimeRoot, "runtime/node/bin-active")),
    ).toBe("bin-current");
    expect(
      await realpath(join(staged.runtimeRoot, "runtime/node/bin-active")),
    ).toBe(join(staged.runtimeRoot, "runtime/node/bin"));
    const runtimeManifest = JSON.parse(
      await readFile(join(staged.resources, "runtime-bootstrap.json"), "utf8"),
    );
    expect(
      runtimeManifest.runtime.files.filter(
        (entry: { code_signed?: boolean }) => entry.code_signed === true,
      ),
    ).toHaveLength(nativeBinaries);
    await expect(
      lstat(join(staged.resources, "runtime")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a bootstrap that no longer matches the packaged sidecar", async () => {
    const { app, state, manifest } = await fixture();
    const document = JSON.parse(await readFile(manifest, "utf8"));
    document.runtime.url = "https://downloads.example.test/tampered.zip";
    const resources = join(app, "Contents/Resources");
    await writeFile(
      join(resources, "runtime-bootstrap.json"),
      `${JSON.stringify(document)}\n`,
      { mode: 0o600 },
    );

    await expect(
      qualification.stageExternalRuntimeForQualification({
        app,
        stateRoot: state,
        exec: verifiedExec,
      }),
    ).rejects.toThrow("QUALIFICATION_RUNTIME_MANIFEST_MISMATCH");
  });

  it("refuses to stage qualification state inside the package build root", async () => {
    const { app } = await fixture();

    await expect(
      qualification.stageExternalRuntimeForQualification({
        app,
        stateRoot: join(app, "..", "qualification-state.noindex"),
        exec: verifiedExec,
      }),
    ).rejects.toThrow("QUALIFICATION_PACKAGE_ROOT_INVALID");
  });

  it("rejects a package record whose runtime manifest digest is changed", async () => {
    const { app, state } = await fixture();
    const resultPath = join(app, "..", "package-result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    result.runtime.manifest_sha256 = "0".repeat(64);
    await writeFile(resultPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
    expect(await digest(result.runtime.manifest)).not.toBe(
      result.runtime.manifest_sha256,
    );

    await expect(
      qualification.stageExternalRuntimeForQualification({
        app,
        stateRoot: state,
        exec: verifiedExec,
      }),
    ).rejects.toThrow("QUALIFICATION_RUNTIME_MANIFEST_MISMATCH");
  });

  it("detects staged runtime permission changes during qualification", async () => {
    const { app, state } = await fixture();
    const staged = await qualification.stageExternalRuntimeForQualification({
      app,
      stateRoot: state,
      exec: verifiedExec,
    });
    await chmod(join(staged.runtimeRoot, "runtime/node/bin/node"), 0o700);

    await expect(
      qualification.verifyExternalRuntimeForQualification({
        ...staged,
        exec: verifiedExec,
      }),
    ).rejects.toThrow("QUALIFICATION_RUNTIME_PERMISSIONS_INVALID");
  });

  it("detects an active runtime pointer changed during qualification", async () => {
    const { app, state } = await fixture();
    const staged = await qualification.stageExternalRuntimeForQualification({
      app,
      stateRoot: state,
      exec: verifiedExec,
    });
    await chmod(staged.activePath, 0o600);
    await writeFile(
      staged.activePath,
      `${JSON.stringify({ schema_version: 1, runtime_id: "other" })}\n`,
      { mode: 0o600 },
    );
    await chmod(staged.activePath, 0o400);

    await expect(
      qualification.verifyExternalRuntimeForQualification({
        ...staged,
        exec: verifiedExec,
      }),
    ).rejects.toThrow("QUALIFICATION_RUNTIME_ACTIVE_INVALID");
  });
});
