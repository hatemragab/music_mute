import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  projectStoreEngineSource,
  stageStoreEngineAuthorityProfile,
  STORE_ENGINE_PROFILE_READER,
  STORE_ENGINE_PROFILE_SOURCE_MARKER,
} from "../packaging/store/engine-profile.js";

const component = resolve(import.meta.dirname, ".."),
  engine = join(component, "../worker/engine/musicmute_engine"),
  marker = STORE_ENGINE_PROFILE_SOURCE_MARKER;

describe("fixed supplementary Python package authority", () => {
  it("preserves every production engine byte and changes only one reader literal in the local-test projection", async () => {
    for (const name of (await readdir(engine)).filter((name) =>
      name.endsWith(".py"),
    )) {
      const source = await readFile(join(engine, name)),
        development = projectStoreEngineSource(name, source, "local-test-v1");
      expect(projectStoreEngineSource(name, source, "store-v1")).toEqual(
        source,
      );
      expect(development).toEqual(
        name === STORE_ENGINE_PROFILE_READER
          ? Buffer.from(
              source
                .toString("utf8")
                .replace(marker, 'PACKAGE_BUILD_PROFILE = "local-test-v1"\n'),
            )
          : source,
      );
    }
  });
  it("rejects absent, repeated, altered and already projected local-test selectors", () => {
    for (const source of [
      "# no selector\n",
      marker + marker,
      marker.replace("store-v1", "local-test-v1"),
      marker.replace("store-v1", "unknown"),
      marker.replace("\n", "\r\n"),
      marker + 'PACKAGE_BUILD_PROFILE = "local-test-v1"\n',
    ])
      expect(() =>
        projectStoreEngineSource(
          STORE_ENGINE_PROFILE_READER,
          Buffer.from(source),
          "local-test-v1",
        ),
      ).toThrow("STORE_ENGINE_PROFILE_INVALID");
    expect(() =>
      projectStoreEngineSource(
        STORE_ENGINE_PROFILE_READER,
        Buffer.from(marker),
        "invalid" as never,
      ),
    ).toThrow("STORE_ENGINE_PROFILE_INVALID");
    expect(
      projectStoreEngineSource(
        STORE_ENGINE_PROFILE_READER,
        Buffer.from("# existing Store fixture\n"),
        "store-v1",
      ),
    ).toEqual(Buffer.from("# existing Store fixture\n"));
  });
  it.each(["store-v1", "local-test-v1"] as const)(
    "compiled %s staging and protected-adapter checks require exact matching projection and preserve source",
    async (profile) => {
      const folder = await realpath(
        await mkdtemp(join(tmpdir(), "store-engine-profile-")),
      );
      try {
        const root = join(folder, "payload"),
          workerRoot = join(folder, "repository/worker"),
          componentRoot = join(folder, "repository/windows-desktop"),
          output = join(folder, `${profile}.mjs`);
        await build({
          absWorkingDir: component,
          stdin: {
            contents:
              "export * from './packaging/store/engine-profile.js'; export { verifyStoreWorkerProtectedAdapters } from './packaging/store/acquisition.js';",
            resolveDir: component,
            sourcefile: "profile-test-entry.ts",
            loader: "ts",
          },
          outfile: output,
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node24",
          define: {
            __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__: JSON.stringify(profile),
          },
        });
        const consumer = (await import(output)) as {
          projectStoreEngineSource: typeof projectStoreEngineSource;
          stageStoreEngineAuthorityProfile: typeof stageStoreEngineAuthorityProfile;
          verifyStoreWorkerProtectedAdapters(
            root: string,
            component: string,
          ): Promise<void>;
        };
        const source = await readFile(
          join(engine, STORE_ENGINE_PROFILE_READER),
        );
        for (const name of [
          STORE_ENGINE_PROFILE_READER,
          "store_consumer_personal.py",
          "store_qualification.py",
        ]) {
          const bytes = await readFile(join(engine, name));
          for (const base of [
            join(workerRoot, "engine/musicmute_engine"),
            join(root, "app/engine/musicmute_engine"),
          ]) {
            await mkdir(base, { recursive: true });
            await writeFile(join(base, name), bytes, { flag: "wx" });
          }
        }
        const downloader = "store_downloader_bootstrap.py",
          downloaderBytes = await readFile(
            join(component, "../chrome-extension/engine", downloader),
          );
        for (const base of [
          join(folder, "repository/chrome-extension/engine"),
          join(root, "tools/downloader"),
        ]) {
          await mkdir(base, { recursive: true });
          await writeFile(join(base, downloader), downloaderBytes, {
            flag: "wx",
          });
        }
        await mkdir(componentRoot);
        const receipt = await consumer.stageStoreEngineAuthorityProfile(
          root,
          workerRoot,
        );
        expect(receipt.profile).toBe(profile);
        expect(
          await readFile(
            join(
              workerRoot,
              "engine/musicmute_engine",
              STORE_ENGINE_PROFILE_READER,
            ),
          ),
        ).toEqual(source);
        await consumer.verifyStoreWorkerProtectedAdapters(root, componentRoot);
        const staged = join(
            root,
            "app/engine/musicmute_engine",
            STORE_ENGINE_PROFILE_READER,
          ),
          foreign = projectStoreEngineSource(
            STORE_ENGINE_PROFILE_READER,
            source,
            profile === "store-v1" ? "local-test-v1" : "store-v1",
          );
        await writeFile(staged, foreign);
        await expect(
          consumer.verifyStoreWorkerProtectedAdapters(root, componentRoot),
        ).rejects.toThrow("STORE_ACQUISITION_INVALID");
        if (profile === "store-v1")
          await expect(
            consumer.stageStoreEngineAuthorityProfile(root, workerRoot),
          ).rejects.toThrow("STORE_ENGINE_PROFILE_INVALID");
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  );
});
