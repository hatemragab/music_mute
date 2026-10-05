import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOWNLOADER_BOOTSTRAP,
  DOWNLOADER_BOOTSTRAP_SHA256,
  DOWNLOADER_WHEELS,
  downloaderToolArguments,
  verifyDownloaderBundle,
} from "../src/companion/downloader-bundle.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-downloader-test-"));
  roots.push(root);
  const directory = join(root, "downloader");
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

describe("verified isolated downloader bundle", () => {
  it("pins the reviewed source bootstrap independently of a bundle identity record", async () => {
    const bootstrap = await readFile(
      new URL("../engine/downloader_bootstrap.py", import.meta.url),
    );
    expect(createHash("sha256").update(bootstrap).digest("hex")).toBe(
      DOWNLOADER_BOOTSTRAP_SHA256,
    );
  });

  it("keeps downloader arguments behind the owned guardian and isolated Python bootstrap", () => {
    const config = {
      runner_path: "/app/local_pipeline.py",
      yt_dlp_path: "/app/python",
      downloader_bundle_root: "/app with spaces/downloader",
    };
    const args = [
      "--ignore-config",
      "--no-plugin-dirs",
      "--",
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    ];
    expect(downloaderToolArguments(config, args)).toEqual([
      config.runner_path,
      "--tool",
      config.yt_dlp_path,
      "--",
      "-I",
      "-B",
      "-S",
      join(config.downloader_bundle_root, DOWNLOADER_BOOTSTRAP),
      ...args,
    ]);
    expect(args).toHaveLength(4);
    expect(
      downloaderToolArguments(config, ["--musicmute-check-ejs"]).at(-1),
    ).toBe("--musicmute-check-ejs");
  });

  it("loads current app code with the separately installed wheel directory", () => {
    const args = downloaderToolArguments(
      {
        runner_path: "/app/engine/local_pipeline.py",
        yt_dlp_path: "/runtime/python",
        downloader_bundle_root: "/runtime/wheels",
        downloader_bootstrap_path: "/app/engine/downloader_bootstrap.py",
      },
      ["--musicmute-check-ejs"],
    );
    expect(args).toEqual([
      "/app/engine/local_pipeline.py",
      "--tool",
      "/runtime/python",
      "--",
      "-I",
      "-B",
      "-S",
      "/app/engine/downloader_bootstrap.py",
      "--musicmute-downloader-root",
      "/runtime/wheels",
      "--musicmute-check-ejs",
    ]);
  });

  it("preserves explicitly configured standalone developer tools", () => {
    expect(
      downloaderToolArguments(
        { runner_path: "/runner", yt_dlp_path: "/dev/yt-dlp" },
        ["--version"],
      ),
    ).toEqual(["/runner", "--tool", "/dev/yt-dlp", "--", "--version"]);
  });

  it("rejects a symlinked bundle instead of importing code through it", async () => {
    const directory = await fixture();
    const alias = `${directory}-alias`;
    await symlink(directory, alias);
    await expect(verifyDownloaderBundle(alias, true)).rejects.toThrow(
      "YT_DLP_IDENTITY_INVALID",
    );
  });

  it("rejects a publicly writable bundle before reading its identity", async () => {
    const directory = await fixture();
    const publicDirectory = join(directory, "public");
    await mkdir(publicDirectory, { mode: 0o777 });
    // Explicit chmod is needed because the process umask may remove write bits.
    const { chmod } = await import("node:fs/promises");
    await chmod(publicDirectory, 0o777);
    await expect(verifyDownloaderBundle(publicDirectory, true)).rejects.toThrow(
      "YT_DLP_IDENTITY_INVALID",
    );
  });

  it("rejects extra Python modules instead of expanding the trusted import surface", async () => {
    const directory = await fixture();
    await writeFile(
      join(directory, "sitecustomize.py"),
      "raise RuntimeError()",
      { mode: 0o600 },
    );
    await expect(verifyDownloaderBundle(directory, false)).rejects.toThrow(
      "YT_DLP_IDENTITY_INVALID",
    );
  });

  it("cannot authorize edited bootstrap code by changing its own identity record", async () => {
    const directory = await fixture();
    const edited = "print('foreign code')\n";
    const identity = {
      schema_version: 1,
      source: "yt-dlp/yt-dlp",
      asset: "python-wheels",
      version: "2026.08.19",
      bootstrap: {
        file: DOWNLOADER_BOOTSTRAP,
        bytes: Buffer.byteLength(edited),
        sha256: createHash("sha256").update(edited).digest("hex"),
      },
      wheels: DOWNLOADER_WHEELS,
    };
    await writeFile(join(directory, DOWNLOADER_BOOTSTRAP), edited, {
      mode: 0o600,
    });
    await writeFile(
      join(directory, "identity.json"),
      JSON.stringify(identity),
      { mode: 0o600 },
    );
    for (const wheel of DOWNLOADER_WHEELS)
      await writeFile(join(directory, wheel.file), "fixture", { mode: 0o600 });
    await expect(verifyDownloaderBundle(directory, false)).rejects.toThrow(
      "YT_DLP_IDENTITY_INVALID",
    );
  });
});
