import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { isBuiltin } from "node:module";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { version as compilerVersion } from "esbuild";

export const AGENT_BUILD_ROLES = Object.freeze([
  "session-agent",
  "login-worker",
  "personal",
  "fleet",
  "prepare",
  "browser-host",
]);
export const WORKER_NODE_AGENT_ROLES = Object.freeze(
  AGENT_BUILD_ROLES.filter((role) => role !== "browser-host"),
);
const THIRD_PARTY = new Set([
  "node_modules/electron/index.js",
  "node_modules/pend/index.js",
  "node_modules/yauzl/crc32.js",
  "node_modules/yauzl/fd-slicer.js",
  "node_modules/yauzl/index.js",
]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function invalid() {
  throw Error("AGENT_BUILD_INPUT_CHANGED");
}
function sourceName(name) {
  if (
    typeof name !== "string" ||
    name.length > 512 ||
    !/^[A-Za-z0-9._/-]+$/u.test(name) ||
    name.includes("//")
  )
    invalid();
  if (THIRD_PARTY.has(name)) return name;
  const local = name.replace(/^\.\.\/(?:worker|chrome-extension)\//u, "");
  if (
    !/^(?:src|protocol|packaging\/store)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|json)$/u.test(
      local,
    ) ||
    local.split("/").some((part) => part === "." || part === "..") ||
    (name.startsWith("../worker/") && !/^(?:src|protocol)\//u.test(local)) ||
    (name.startsWith("../chrome-extension/") && !local.startsWith("src/"))
  )
    invalid();
  return name;
}
async function physical(path) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (await realpath(path)) !== path
  )
    invalid();
  for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
    const info = await lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
    if (ancestor === dirname(ancestor)) break;
  }
}
function identity(info) {
  if (
    !info.isFile() ||
    info.nlink !== 1n ||
    info.ino === 0n ||
    info.size < 1n ||
    info.size > 8n * 1024n ** 2n
  )
    invalid();
  return JSON.stringify(
    [
      info.dev,
      info.ino,
      info.birthtimeNs,
      info.size,
      info.mtimeNs,
      info.ctimeNs,
    ].map(String),
  );
}
async function held(path) {
  await physical(path);
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = identity(await file.stat({ bigint: true }));
    if (identity(await lstat(path, { bigint: true })) !== before) invalid();
    const bytes = await file.readFile();
    if (
      identity(await file.stat({ bigint: true })) !== before ||
      identity(await lstat(path, { bigint: true })) !== before
    )
      invalid();
    await physical(path);
    return { bytes, metadata: before, sha256: sha(bytes) };
  } finally {
    await file.close();
  }
}
export function packageBuildOptions(authorityProfile = "store-v1") {
  if (!["store-v1", "local-test-v1"].includes(authorityProfile)) invalid();
  return {
    define: {
      __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__: JSON.stringify(authorityProfile),
    },
  };
}
/** The command accepts one explicit local-test switch only. Environment and
 * arbitrary compiler definitions cannot choose the package authority. */
export function packageBuildProfileFromArguments(args) {
  if (!Array.isArray(args)) invalid();
  if (args.length === 0) return "store-v1";
  if (args.length === 1 && args[0] === "--local-test-v1")
    return "local-test-v1";
  invalid();
}
/** Both profiles retain the five fixed Node definitions. No caller selects an
 * Electron external, runtime shim or arbitrary define/compile profile. */
export function agentBuildOptions(role, authorityProfile = "store-v1") {
  if (!AGENT_BUILD_ROLES.includes(role)) invalid();
  return {
    define: {
      ...packageBuildOptions(authorityProfile).define,
      ...(WORKER_NODE_AGENT_ROLES.includes(role)
        ? { "process.versions.electron": "undefined" }
        : {}),
    },
  };
}
/** Capture the exact individually held bytes esbuild actually parses. Directory
 * checks are named snapshots, not a continuously retained native tree. */
export function createAgentInputCapture(componentRoot) {
  if (!isAbsolute(componentRoot) || resolve(componentRoot) !== componentRoot)
    invalid();
  const loaded = new Map(),
    compilerDefinitions = new Map();
  return {
    plugin: {
      name: "musicmute-agent-current-inputs",
      setup(build) {
        const options = build.initialOptions;
        compilerDefinitions.set(resolve(componentRoot, options.outfile ?? ""), {
          ...options.define,
        });
        build.onLoad({ filter: /\.(?:tsx?|js|json)$/ }, async ({ path }) => {
          const name = sourceName(
              relative(componentRoot, path).replaceAll("\\", "/"),
            ),
            input = await held(path),
            previous = loaded.get(name);
          if (
            previous &&
            (previous.sha256 !== input.sha256 ||
              previous.metadata !== input.metadata)
          )
            invalid();
          loaded.set(name, input);
          return {
            contents: input.bytes,
            loader: path.endsWith(".tsx")
              ? "tsx"
              : path.endsWith(".ts")
                ? "ts"
                : path.endsWith(".json")
                  ? "json"
                  : "js",
          };
        });
      },
    },
    definitions(outputName) {
      return compilerDefinitions.get(resolve(componentRoot, outputName));
    },
    async pins(names) {
      const result = [];
      for (const name of [...names].sort()) {
        sourceName(name);
        const captured = loaded.get(name),
          current = await held(resolve(componentRoot, name));
        if (
          !captured ||
          captured.sha256 !== current.sha256 ||
          captured.metadata !== current.metadata
        )
          invalid();
        result.push({
          path: name,
          bytes: current.bytes.length,
          sha256: current.sha256,
        });
      }
      return result;
    },
  };
}
/** Materialize only exact compiler-returned code/map outputs. Write:false
 * retains the actual compiler bytes, so post-build same-size edits are detected. */
export async function writeAgentBuildOutputs(componentRoot, results) {
  if (!Array.isArray(results) || results.length !== AGENT_BUILD_ROLES.length)
    invalid();
  await mkdir(resolve(componentRoot, "dist/agent"), { recursive: true });
  await physical(resolve(componentRoot, "dist/agent"));
  for (const [index, result] of results.entries()) {
    const name = `dist/agent/${AGENT_BUILD_ROLES[index]}.cjs`,
      expected = [
        resolve(componentRoot, name),
        resolve(componentRoot, name + ".map"),
      ];
    if (
      !Array.isArray(result.outputFiles) ||
      result.outputFiles.length !== 2 ||
      new Set(result.outputFiles.map((output) => output.path)).size !== 2
    )
      invalid();
    for (const output of result.outputFiles) {
      if (
        !expected.includes(output.path) ||
        !(output.contents instanceof Uint8Array) ||
        output.contents.length < 1 ||
        output.contents.length > 8 * 1024 ** 2
      )
        invalid();
      const temporary = output.path + `.${randomUUID()}.building`;
      await writeFile(temporary, output.contents, { flag: "wx" });
      await rename(temporary, output.path);
    }
  }
}
/** Receipts describe actual compilation inputs/outputs only. They grant no
 * execution, OS package origin, signing, GPU qualification or Ready authority. */
export async function writeAgentBuildInputs(
  componentRoot,
  results,
  capture,
  authorityProfile = "store-v1",
) {
  packageBuildOptions(authorityProfile);
  if (
    compilerVersion !== "0.28.2" ||
    !Array.isArray(results) ||
    results.length !== AGENT_BUILD_ROLES.length
  )
    invalid();
  const names = new Set(),
    agents = [];
  for (const [index, result] of results.entries()) {
    const role = AGENT_BUILD_ROLES[index],
      file = `${role}.cjs`,
      outputName = `dist/agent/${file}`,
      graph = result.metafile,
      compileDefinitions = capture.definitions(outputName),
      expectedDefinitions = agentBuildOptions(role, authorityProfile).define,
      output = graph?.outputs?.[outputName],
      input = await held(resolve(componentRoot, outputName)),
      compiled = result.outputFiles?.find(
        (file) => file.path === resolve(componentRoot, outputName),
      );
    if (
      !output ||
      !compileDefinitions ||
      Object.keys(compileDefinitions).length !==
        Object.keys(expectedDefinitions).length ||
      Object.entries(expectedDefinitions).some(
        ([key, value]) => compileDefinitions[key] !== value,
      ) ||
      !compiled ||
      !input.bytes.equals(compiled.contents) ||
      output.bytes !== input.bytes.length ||
      output.entryPoint !==
        `src/agent/${role === "browser-host" ? "browser-host-cli" : role}.ts` ||
      Object.keys(graph.outputs).some(
        (name) => name !== outputName && name !== outputName + ".map",
      )
    )
      invalid();
    for (const [name, entry] of Object.entries(graph.inputs)) {
      sourceName(name);
      names.add(name);
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1) invalid();
      for (const dependency of entry.imports) {
        if (
          dependency.external === true
            ? !isBuiltin(dependency.path)
            : !Object.hasOwn(graph.inputs, dependency.path)
        )
          invalid();
      }
    }
    if (
      WORKER_NODE_AGENT_ROLES.includes(role) &&
      Object.hasOwn(graph.inputs, "node_modules/electron/index.js")
    )
      invalid();
    if (
      output.imports.some((entry) =>
        entry.external === true
          ? !isBuiltin(entry.path)
          : !Object.hasOwn(graph.inputs, entry.path),
      )
    )
      invalid();
    agents.push({
      role,
      file,
      bytes: input.bytes.length,
      sha256: input.sha256,
      compileDefinitions,
      graph: { inputs: graph.inputs, outputs: { [outputName]: output } },
    });
  }
  const sources = await capture.pins(names);
  for (const agent of agents)
    for (const [path, input] of Object.entries(agent.graph.inputs)) {
      if (sources.find((pin) => pin.path === path)?.bytes !== input.bytes)
        invalid();
    }
  const bytes = Buffer.from(
      JSON.stringify(
        {
          version: 1,
          purpose: "store-agent-compiled-inputs",
          authorityProfile,
          compiler: { name: "esbuild", version: compilerVersion },
          sources,
          agents,
        },
        null,
        2,
      ) + "\n",
    ),
    temporary = resolve(
      componentRoot,
      `dist/.agent-build-inputs-${randomUUID()}.json`,
    ),
    destination = resolve(componentRoot, "dist/agent-build-inputs.json");
  if (bytes.length > 4 * 1024 ** 2) invalid();
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, destination);
  const stored = await held(destination);
  if (!stored.bytes.equals(bytes)) invalid();
  await capture.pins(names);
  for (const agent of agents) {
    const current = await held(
      resolve(componentRoot, "dist/agent", agent.file),
    );
    if (current.bytes.length !== agent.bytes || current.sha256 !== agent.sha256)
      invalid();
  }
  return bytes;
}
