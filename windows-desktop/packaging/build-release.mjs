import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { stageSharedExtension } from "./shared-extension.mjs";

const require = createRequire(import.meta.url),
  execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
async function release() {
  const [approvalPath, inputsRoot, stage] = process.argv.slice(2);
  if (
    process.argv.length !== 5 ||
    ![approvalPath, inputsRoot, stage].every(
      (value) => typeof value === "string" && isAbsolute(value),
    )
  )
    throw new Error("PACKAGE_ARGUMENT_INVALID");
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("WINDOWS_PACKAGE_MACHINE_REQUIRED");
  // All production signature checks execute on the authorized Windows builder.
  // The Mac can run only the separate injected/portable fixtures.
  const assets = require(
    join(root, "dist", "packaging", "validate-assets.cjs"),
  );
  const { verifySignedPe } = require("./authenticode.cjs");
  const {
    executedBuildGraphs,
    bundledNotices,
    verifyLicensedBuildAssets,
  } = require("./inventory.cjs");
  const approval = assets.parseApprovedPackageInputs(
    assets.parsePackageJson(await assets.packageFile(approvalPath, 65536)),
  );
  const original = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (approval.appVersion !== original.version)
    throw new Error("PACKAGE_VERSION_MISMATCH");
  await assets.validateApprovedPackageAssets(
    inputsRoot,
    approval,
    verifySignedPe,
  );
  // A new exclusive stage avoids overwriting source, previous candidates or data.
  await mkdir(stage);
  for (const folder of [
    "app/dist/main",
    "app/dist/preload",
    "app/dist/renderer",
    "app/dist/licenses",
    "resources/native",
    "resources/runtime",
    "resources/extension",
    "resources/notices",
    "root",
    "installer",
  ])
    await mkdir(join(stage, folder), { recursive: true });
  const copy = async (from, to) => {
    const bytes = await assets.packageFile(from, 256 * 1024 ** 2);
    await writeFile(to, bytes, { flag: "wx" });
  };
  const built = await assets.packageInventory(join(root, "dist"));
  await verifyLicensedBuildAssets(root, join(root, "dist"));
  const buildGraphs = assets.parsePackageJson(
    await assets.packageFile(
      join(root, "dist/build-metafiles.json"),
      4 * 1024 ** 2,
    ),
    4 * 1024 ** 2,
  );
  executedBuildGraphs(buildGraphs);
  await writeFile(
    join(stage, "resources/notices/bundled.txt"),
    await bundledNotices(root, buildGraphs),
    { flag: "wx" },
  );
  const approvedBuild = built.filter((path) =>
    /^(?:main\/main\.cjs|preload\/index\.cjs|renderer\/.*\.(?:html|js|css|ttf|woff2|png|svg)|licenses\/.*\.txt)$/u.test(
      path,
    ),
  );
  if (
    ![
      "main/main.cjs",
      "preload/index.cjs",
      "renderer/index.html",
      "renderer/app.js",
    ].every((path) => approvedBuild.includes(path))
  )
    throw new Error("PACKAGE_BUILD_MISSING");
  const main = (
    await assets.packageFile(join(root, "dist/main/main.cjs"), 32 * 1024 ** 2)
  ).toString("utf8");
  if (
    ![
      "--installer-maintenance",
      "--native-browser-stdio",
      "--headless-account",
      "PACKAGED_TRUST_REQUIRED",
    ].every((text) => main.includes(text))
  )
    throw new Error("PACKAGE_EXECUTED_ENTRY_UNBOUND");
  for (const path of approvedBuild) {
    await mkdir(resolve(stage, "app/dist", path, ".."), { recursive: true });
    await copy(join(root, "dist", path), join(stage, "app/dist", path));
  }
  for (const entry of approval.entries) {
    let to;
    if (entry.path === "app-icon.ico")
      to = join(stage, "installer", "app-icon.ico");
    else if (
      entry.path === "native/MusicMuteSession.exe" ||
      entry.path === "native/MusicMuteChromeHost.exe"
    )
      to = join(stage, "root", entry.path.slice(7));
    else to = join(stage, "resources", entry.path);
    await mkdir(resolve(to, ".."), { recursive: true });
    await writeFile(to, await assets.approvedPackageFile(inputsRoot, entry), {
      flag: "wx",
    });
  }
  await copy(
    join(stage, "resources/native/musicmute-native.exe"),
    join(stage, "installer/musicmute-native.exe"),
  );
  await copy(
    join(root, "dist/agent/browser-host.cjs"),
    join(stage, "resources/native/browser-host.cjs"),
  );
  await stageSharedExtension(
    join(stage, "resources/extension"),
    assets.packageFile,
  );
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const helper = await readFile(
      join(stage, "resources/native/musicmute-native.exe"),
    ),
    launcher = await readFile(join(stage, "root/MusicMuteSession.exe")),
    host = await readFile(join(stage, "root/MusicMuteChromeHost.exe")),
    entry = await readFile(join(stage, "resources/native/browser-host.cjs"));
  const manifest = JSON.parse(
    await readFile(join(stage, "resources/extension/manifest.json"), "utf8"),
  );
  const extensionId = Array.from(
    digest(Buffer.from(manifest.key, "base64")).slice(0, 32),
    (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)),
  ).join("");
  if (extensionId !== "acmgefmmndomcpdlgnafkjbgobinllep")
    throw new Error("PACKAGE_EXTENSION_ID_INVALID");
  const json = async (relative, value) =>
    writeFile(join(stage, relative), JSON.stringify(value) + "\n", {
      flag: "wx",
    });
  await json("resources/desktop-build.json", {
    version: 1,
    appVersion: approval.appVersion,
    buildNumber: approval.appBuildNumber,
  });
  await json("resources/native/manifest.json", {
    version: 1,
    sha256: digest(helper),
  });
  await json("resources/native/launcher-manifest.json", {
    version: 1,
    sha256: digest(launcher),
    bytes: launcher.length,
  });
  await json("resources/native/browser-manifest.json", {
    version: 1,
    extensionId,
    hostSha256: digest(host),
    hostBytes: host.length,
    entrySha256: digest(entry),
    entryBytes: entry.length,
  });
  const resourceEntries = [];
  for (const placement of ["resources", "root"])
    for (const path of await assets.packageInventory(join(stage, placement)))
      resourceEntries.push(
        assets.packageEntry(
          placement === "root" ? "app" : "resources",
          path,
          await readFile(join(stage, placement, path)),
        ),
      );
  const codeEntries = [];
  for (const path of await assets.packageInventory(join(stage, "app/dist")))
    codeEntries.push(
      assets.packageEntry(
        "app",
        `dist/${path}`,
        await readFile(join(stage, "app/dist", path)),
      ),
    );
  const payloadSha256 = digest(
    Buffer.from(
      JSON.stringify({
        version: 1,
        appVersion: approval.appVersion,
        publisherSha256: approval.publisherSha256,
        code: codeEntries,
        resources: resourceEntries,
      }),
    ),
  );
  await json("resources/app-update-identity.json", {
    version: 1,
    appVersion: approval.appVersion,
    payloadSha256,
  });
  resourceEntries.push(
    assets.packageEntry(
      "resources",
      "app-update-identity.json",
      await readFile(join(stage, "resources/app-update-identity.json")),
    ),
  );
  await json("app/packaged-resources.json", {
    version: 1,
    appId: "com.musicmute.local.windows",
    appVersion: approval.appVersion,
    payloadSha256,
    publisherSha256: approval.publisherSha256,
    entries: resourceEntries,
  });
  await json("app/package.json", {
    name: original.name,
    version: original.version,
    private: true,
    main: "dist/main/main.cjs",
    description: "MusicMute Local for Windows",
    author: { name: approval.publisherName },
  });
  await copyFile(
    join(root, "packaging/installer.nsh"),
    join(stage, "installer/installer.nsh"),
  );
  // afterSign derives this exact list from the real Electron/native payload,
  // including framework DLLs and ASAR. It never names per-user data roots.
  await execute(
    process.execPath,
    [join(root, "packaging/build-nsis.cjs"), stage],
    {
      cwd: root,
      env: { ...process.env, MUSICMUTE_PACKAGE_STAGE: stage },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: 600000,
    },
  );
}
release().catch((error) => {
  process.stderr.write(
    `${error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "PACKAGE_BUILD_FAILED"}\n`,
  );
  process.exitCode = 2;
});
