import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { isBuiltin } from "node:module";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseStoreBuildDocument } from "./document-json.js";
import { hashStoreFile, type StoreInventoryEntry } from "./inventory.js";
import { PACKAGE_AUTHORITY_PROFILE } from "../../src/shared/package-build-profile.js";

export const STORE_AGENT_BUILD_INPUTS = "dist/agent-build-inputs.json";
export const STORE_AGENT_NOTICE_PATH = "runtime/licenses/agent/bundled.txt";
export const STORE_AGENT_ROLES = Object.freeze([
  "session-agent",
  "login-worker",
  "personal",
  "fleet",
  "prepare",
  "browser-host",
] as const);
type Role = (typeof STORE_AGENT_ROLES)[number];
export const STORE_WORKER_AGENT_ROLES = Object.freeze(
  STORE_AGENT_ROLES.filter((role) => role !== "browser-host"),
);
const thirdPartyFiles = Object.freeze([
  "node_modules/electron/index.js",
  "node_modules/pend/index.js",
  "node_modules/yauzl/crc32.js",
  "node_modules/yauzl/fd-slicer.js",
  "node_modules/yauzl/index.js",
]);
/** Exact notice bytes from the existing lock-qualified project dependencies. */
export const STORE_AGENT_LICENSES = Object.freeze(
  [
    {
      name: "electron",
      version: "44.7.0",
      bytes: 1096,
      sha256:
        "5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d",
      manifestBytes: 744,
      manifestSha256:
        "af9a6fdc372c2516076375d676ba5005937513e1bdcc6769768217a1561b18b6",
    },
    {
      name: "pend",
      version: "1.2.0",
      bytes: 1082,
      sha256:
        "7e64acffcb0d20d33f5a86949ffd4a99ae045b10c7332a9c3a58635876c16880",
      manifestBytes: 410,
      manifestSha256:
        "1e4f01d39cc13c261f7ab81d0509d36bd98d8eceaf9ed75f2ab274286f3c3920",
    },
    {
      name: "yauzl",
      version: "3.4.0",
      bytes: 1077,
      sha256:
        "b303783d5eb7ca50b853ffa5f145e4e7998fab339831d848f507ca6cd970577a",
      manifestBytes: 762,
      manifestSha256:
        "d7d5418b74b185df4ad276b73cf1e36040dd417d22520354e609e2748a29fcbd",
    },
  ].map((row) => Object.freeze(row)),
);
interface Agent {
  readonly role: Role;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sources: readonly string[];
}
export interface StoreAgentBuildInputs {
  readonly version: 1;
  readonly purpose: "store-agent-compiled-inputs";
  readonly authorityProfile: typeof PACKAGE_AUTHORITY_PROFILE;
  readonly sources: readonly StoreInventoryEntry[];
  readonly agents: readonly Agent[];
}
function invalid(): never {
  throw new Error("STORE_AGENT_NOTICE_INVALID");
}
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const proto = Object.getPrototypeOf(value),
    keys = Reflect.ownKeys(value);
  if (
    (proto !== Object.prototype && proto !== null) ||
    keys.length > required.length + optional.length ||
    keys.some(
      (key) =>
        typeof key !== "string" || ![...required, ...optional].includes(key),
    )
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) invalid();
    result[key as string] = d.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) invalid();
  return result;
}
function dictionary(value: unknown, maximum: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < 1 ||
    keys.length > maximum ||
    keys.some((key) => typeof key !== "string")
  )
    invalid();
  return record(value, keys as string[]);
}
function size(value: unknown, maximum = 8 * 1024 ** 2): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  )
    invalid();
  return value as number;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}
function sourcePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[A-Za-z0-9._/-]+$/u.test(value) ||
    value.includes("//") ||
    /(?:^|\/)(?:tests?|__tests__|\.env(?:\.[^/]+)?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(
      value,
    )
  )
    invalid();
  if (thirdPartyFiles.includes(value)) return value;
  const trimmed = value.replace(/^\.\.\/(?:worker|chrome-extension)\//u, "");
  if (
    !/^(?:src|protocol|packaging\/store)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|json)$/u.test(
      trimmed,
    ) ||
    trimmed.split("/").some((part) => part === "." || part === "..")
  )
    invalid();
  if (
    (value.startsWith("../worker/") && !/^(?:src|protocol)\//u.test(trimmed)) ||
    (value.startsWith("../chrome-extension/") && !trimmed.startsWith("src/"))
  )
    invalid();
  return value;
}
function imports(value: unknown, names: ReadonlySet<string>) {
  if (!Array.isArray(value) || value.length > 4096) invalid();
  for (const raw of value) {
    const row = record(raw, ["path", "kind"], ["external", "original"]);
    if (
      typeof row.path !== "string" ||
      row.path.length > 512 ||
      !["import-statement", "require-call", "dynamic-import"].includes(
        row.kind as string,
      ) ||
      (row.external !== undefined && row.external !== true) ||
      (row.original !== undefined &&
        (typeof row.original !== "string" ||
          row.original.length > 512 ||
          /[\p{Cc}\p{Cf}]/u.test(row.original)))
    )
      invalid();
    if (row.external === true ? !isBuiltin(row.path) : !names.has(row.path))
      invalid();
  }
}
/** Compiler metadata is only an input/output binding. It does not prove a
 * guardian run, OS package origin, Store approval or permission to launch. */
export function parseStoreAgentBuildInputsBytes(
  bytes: Uint8Array,
): StoreAgentBuildInputs {
  const row = record(
      parseStoreBuildDocument(bytes, 4 * 1024 ** 2),
      ["version", "purpose", "compiler", "sources", "agents"],
      ["authorityProfile"],
    ),
    compiler = record(row.compiler, ["name", "version"]);
  if (
    row.version !== 1 ||
    row.purpose !== "store-agent-compiled-inputs" ||
    (row.authorityProfile === undefined ? "store-v1" : row.authorityProfile) !==
      PACKAGE_AUTHORITY_PROFILE ||
    compiler.name !== "esbuild" ||
    compiler.version !== "0.28.2" ||
    !Array.isArray(row.sources) ||
    row.sources.length < 6 ||
    row.sources.length > 4096 ||
    !Array.isArray(row.agents) ||
    row.agents.length !== STORE_AGENT_ROLES.length
  )
    invalid();
  let previous = "";
  const folded = new Set<string>();
  const sources = row.sources.map((raw) => {
    const pin = record(raw, ["path", "bytes", "sha256"]),
      path = sourcePath(pin.path);
    if (path <= previous || folded.has(path.toLowerCase())) invalid();
    previous = path;
    folded.add(path.toLowerCase());
    return Object.freeze({
      path,
      bytes: size(pin.bytes),
      sha256: digest(pin.sha256),
    });
  });
  const names = new Set(sources.map((source) => source.path)),
    used = new Set<string>();
  const agents = row.agents.map((raw, index) => {
    const agent = record(
        raw,
        ["role", "file", "bytes", "sha256", "graph"],
        ["compileDefinitions"],
      ),
      role = STORE_AGENT_ROLES[index]!,
      expectedDefinitions = {
        __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__: JSON.stringify(
          PACKAGE_AUTHORITY_PROFILE,
        ),
        ...(role !== "browser-host"
          ? { "process.versions.electron": "undefined" }
          : {}),
      },
      definitions: Record<string, unknown> =
        agent.compileDefinitions === undefined &&
        row.authorityProfile === undefined
          ? expectedDefinitions
          : record(agent.compileDefinitions, Object.keys(expectedDefinitions)),
      entry = `src/agent/${role === "browser-host" ? "browser-host-cli" : role}.ts`,
      graph = record(agent.graph, ["inputs", "outputs"]),
      graphInputs = dictionary(graph.inputs, 4096),
      outputs = dictionary(graph.outputs, 1),
      outputName = Object.keys(outputs)[0]!,
      output = record(outputs[outputName], [
        "imports",
        "exports",
        "entryPoint",
        "inputs",
        "bytes",
      ]);
    if (
      agent.role !== role ||
      Object.entries(expectedDefinitions).some(
        ([key, value]) => definitions[key] !== value,
      ) ||
      agent.file !== `${role}.cjs` ||
      (outputName !== `dist/agent/${role}.cjs` &&
        outputName !==
          `${role === "browser-host" ? "browser-host-cli" : role}.js`) ||
      output.entryPoint !== entry ||
      !Object.hasOwn(graphInputs, entry) ||
      !Array.isArray(output.exports) ||
      output.exports.some(
        (name) => typeof name !== "string" || name.length > 128,
      ) ||
      size(output.bytes) !== size(agent.bytes)
    )
      invalid();
    const graphNames = new Set(Object.keys(graphInputs));
    if (
      role !== "browser-host" &&
      graphNames.has("node_modules/electron/index.js")
    )
      invalid();
    for (const [path, raw] of Object.entries(graphInputs)) {
      sourcePath(path);
      if (!names.has(path)) invalid();
      const input = record(raw, ["bytes", "imports"], ["format"]),
        pin = sources.find((source) => source.path === path)!;
      if (
        size(input.bytes) !== pin.bytes ||
        (input.format !== undefined &&
          input.format !== "esm" &&
          input.format !== "cjs")
      )
        invalid();
      imports(input.imports, graphNames);
      used.add(path);
    }
    imports(output.imports, graphNames);
    for (const [path, raw] of Object.entries(dictionary(output.inputs, 4096))) {
      if (!graphNames.has(path)) invalid();
      const input = record(raw, ["bytesInOutput"]);
      if (
        !Number.isSafeInteger(input.bytesInOutput) ||
        (input.bytesInOutput as number) < 0 ||
        (input.bytesInOutput as number) > size(agent.bytes)
      )
        invalid();
    }
    return Object.freeze({
      role,
      file: agent.file as string,
      bytes: size(agent.bytes),
      sha256: digest(agent.sha256),
      sources: Object.freeze([...graphNames].sort()),
    });
  });
  if (names.size !== used.size || [...names].some((name) => !used.has(name)))
    invalid();
  return Object.freeze({
    version: 1,
    purpose: "store-agent-compiled-inputs",
    authorityProfile: PACKAGE_AUTHORITY_PROFILE,
    sources: Object.freeze(sources),
    agents: Object.freeze(agents),
  });
}
async function physical(path: string, directory: boolean) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (await realpath(path)) !== path
  )
    invalid();
  for (let candidate = path; ; candidate = dirname(candidate)) {
    const s = await lstat(candidate);
    if (
      s.isSymbolicLink() ||
      ((candidate !== path || directory) && !s.isDirectory())
    )
      invalid();
    if (candidate === dirname(candidate)) break;
  }
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function held(path: string, maximum: number) {
  await physical(path, false);
  const before = await hashStoreFile(path);
  if (before.bytes < 1 || before.bytes > maximum) invalid();
  const raw = await readFile(path),
    after = await hashStoreFile(path);
  if (
    raw.length !== before.bytes ||
    hash(raw) !== before.sha256 ||
    after.bytes !== before.bytes ||
    after.sha256 !== before.sha256
  )
    invalid();
  return raw;
}
/** Reads only fixed current project compiler inputs and dependency notices. */
export async function buildStoreAgentNotices(componentRoot: string) {
  await physical(componentRoot, true);
  const receipt = await held(
      join(componentRoot, STORE_AGENT_BUILD_INPUTS),
      4 * 1024 ** 2,
    ),
    parsed = parseStoreAgentBuildInputsBytes(receipt),
    checks = [
      ...parsed.sources.map((source) => ({
        ...source,
        absolute: resolve(componentRoot, source.path),
      })),
      ...parsed.agents.map((agent) => ({
        path: `dist/agent/${agent.file}`,
        bytes: agent.bytes,
        sha256: agent.sha256,
        absolute: join(componentRoot, "dist/agent", agent.file),
      })),
    ];
  const verify = async () => {
    for (const pin of checks) {
      const raw = await held(pin.absolute, 8 * 1024 ** 2);
      if (raw.length !== pin.bytes || hash(raw) !== pin.sha256) invalid();
    }
  };
  await verify();
  const lock = parseStoreBuildDocument(
      await held(join(componentRoot, "package-lock.json"), 4 * 1024 ** 2),
    ) as { packages?: unknown },
    packages = dictionary(lock.packages, 4096),
    chunks = [
      "Third-party code bundled in the five Worker-owned agents. The separately verified GUI browser host is not part of this payload. Runtime/native notices are supplied separately.",
    ];
  const bundled = STORE_AGENT_LICENSES.filter((pin) =>
    parsed.agents.some(
      (agent) =>
        agent.role !== "browser-host" &&
        agent.sources.some((source) =>
          source.startsWith(`node_modules/${pin.name}/`),
        ),
    ),
  );
  if (bundled.length === 0)
    chunks.push(
      "No third-party JavaScript modules are present in this compiler graph.",
    );
  for (const pin of bundled) {
    const packageRoot = join(componentRoot, "node_modules", pin.name),
      manifestBytes = await held(join(packageRoot, "package.json"), 65536),
      manifest = parseStoreBuildDocument(manifestBytes) as {
        name?: unknown;
        version?: unknown;
        license?: unknown;
      },
      locked = packages[`node_modules/${pin.name}`] as {
        version?: unknown;
        license?: unknown;
      };
    if (
      manifestBytes.length !== pin.manifestBytes ||
      hash(manifestBytes) !== pin.manifestSha256 ||
      manifest.name !== pin.name ||
      manifest.version !== pin.version ||
      manifest.license !== "MIT" ||
      locked?.version !== pin.version ||
      locked.license !== "MIT"
    )
      invalid();
    const license = await held(join(packageRoot, "LICENSE"), 65536);
    if (license.length !== pin.bytes || hash(license) !== pin.sha256) invalid();
    chunks.push(
      `\n${pin.name}@${pin.version}\n\nLICENSE\n${new TextDecoder("utf-8", { fatal: true }).decode(license)}`,
    );
  }
  await verify();
  if (
    !(
      await held(join(componentRoot, STORE_AGENT_BUILD_INPUTS), 4 * 1024 ** 2)
    ).equals(receipt)
  )
    invalid();
  return Buffer.from(chunks.join("\n") + "\n");
}
export async function stageStoreAgentNotices(
  root: string,
  componentRoot: string,
) {
  const bytes = await buildStoreAgentNotices(componentRoot),
    destination = join(root, STORE_AGENT_NOTICE_PATH);
  await physical(root, true);
  await mkdir(dirname(destination), { recursive: true });
  await physical(dirname(destination), true);
  await writeFile(destination, bytes, { flag: "wx" });
  if (!(await held(destination, 65536)).equals(bytes)) invalid();
}
export async function verifyStoreAgentNotices(
  root: string,
  componentRoot: string,
) {
  const expected = await buildStoreAgentNotices(componentRoot),
    actual = await held(join(root, STORE_AGENT_NOTICE_PATH), 65536);
  if (!expected.equals(actual)) invalid();
}
/** The shared compiler builds six roles; the Worker package owns only five.
 * Preserve the GUI browser host as a separate protected GUI-owned artifact. */
export async function copyStoreWorkerAgentInputs(
  componentRoot: string,
  destination: string,
) {
  await buildStoreAgentNotices(componentRoot);
  if (
    !isAbsolute(destination) ||
    resolve(destination) !== destination ||
    destination.toLowerCase() === componentRoot.toLowerCase() ||
    destination.toLowerCase().startsWith(componentRoot.toLowerCase() + sep)
  )
    invalid();
  await physical(dirname(destination), true);
  try {
    await lstat(destination);
    invalid();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(destination);
  for (const role of STORE_WORKER_AGENT_ROLES) {
    const source = join(componentRoot, "dist/agent", `${role}.cjs`),
      target = join(destination, `${role}.cjs`),
      pin = await hashStoreFile(source);
    await physical(source, false);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    for (const path of [source, target]) {
      const current = await hashStoreFile(path);
      if (current.bytes !== pin.bytes || current.sha256 !== pin.sha256)
        invalid();
    }
  }
  await buildStoreAgentNotices(componentRoot);
  return destination;
}
