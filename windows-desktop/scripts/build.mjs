import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AGENT_BUILD_ROLES,
  agentBuildOptions,
  packageBuildOptions,
  packageBuildProfileFromArguments,
  createAgentInputCapture,
  writeAgentBuildOutputs,
  writeAgentBuildInputs,
} from "./agent-build-inputs.mjs";

const root = resolve(import.meta.dirname, "..");
const localDebug = process.argv.includes("--local-debug");
const authorityProfile = packageBuildProfileFromArguments(
  process.argv.slice(2).filter((arg) => arg !== "--local-debug"),
);
const common = {
  absWorkingDir: root,
  bundle: true,
  sourcemap: true,
  metafile: true,
  ...packageBuildOptions(authorityProfile),
};
const agentCapture = createAgentInputCapture(root);
await mkdir(resolve(root, "dist/renderer"), { recursive: true });
await mkdir(resolve(root, "dist/renderer/fonts"), { recursive: true });
await mkdir(resolve(root, "dist/licenses"), { recursive: true });
await copyFile(
  resolve(root, "../chrome-extension/macos/Resources/Fonts/NotoSansArabic.ttf"),
  resolve(root, "dist/renderer/fonts/NotoSansArabic.ttf"),
);
await copyFile(
  resolve(
    root,
    "../chrome-extension/macos/Resources/licenses/noto_sans_arabic_ofl.txt",
  ),
  resolve(root, "dist/licenses/noto_sans_arabic_ofl.txt"),
);
for (const [source, target] of [
  ["node_modules/electron/LICENSE", "electron_mit.txt"],
  ["packaging/notices/google-branding.txt", "google_branding.txt"],
])
  await copyFile(resolve(root, source), resolve(root, "dist/licenses", target));
const results = await Promise.all([
  build({
    ...common,
    entryPoints: ["packaging/validate-assets.ts"],
    outfile: "dist/packaging/validate-assets.cjs",
    platform: "node",
    target: "node24",
    format: "cjs",
  }),
  build({
    ...common,
    entryPoints: ["acceptance/runner.ts"],
    outfile: "dist/acceptance/runner.cjs",
    platform: "node",
    target: "node24",
    format: "cjs",
  }),
  ...AGENT_BUILD_ROLES.map((role) =>
    build({
      ...common,
      ...agentBuildOptions(role, authorityProfile),
      write: false,
      entryPoints: [
        `src/agent/${role === "browser-host" ? "browser-host-cli" : role}.ts`,
      ],
      outfile: `dist/agent/${role}.cjs`,
      platform: "node",
      target: "node24",
      format: "cjs",
      plugins: [agentCapture.plugin],
    }),
  ),
  build({
    ...common,
    entryPoints: ["src/main/main.ts"],
    define: {
      ...common.define,
      __MUSICMUTE_LOCAL_DEBUG__: JSON.stringify(localDebug),
    },
    outfile: "dist/main/main.cjs",
    platform: "node",
    target: "node24",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/preload/index.ts"],
    outfile: "dist/preload/index.cjs",
    platform: "node",
    target: "node24",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/renderer/index.tsx"],
    outfile: "dist/renderer/app.js",
    platform: "browser",
    target: "chrome150",
    format: "esm",
    loader: { ".ttf": "file" },
    assetNames: "fonts/[name]",
  }),
  build({
    ...common,
    entryPoints: ["src/companion/entry.ts"],
    outfile: "dist/companion/desktop.mjs",
    platform: "node",
    target: "node24",
    format: "esm",
  }),
]);
const agentResults = results.slice(2, 2 + AGENT_BUILD_ROLES.length);
await writeAgentBuildOutputs(root, agentResults);
await writeAgentBuildInputs(root, agentResults, agentCapture, authorityProfile);
await writeFile(
  resolve(root, "dist/renderer/index.html"),
  await readFile(resolve(root, "src/renderer/index.html")),
);
await writeFile(
  resolve(root, "dist/build-metafiles.json"),
  JSON.stringify(
    results.map((r) => r.metafile),
    null,
    2,
  ) + "\n",
);
