import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import {
  STORE_PRODUCTS,
  STORE_PROTOCOL_ABI,
  classifyStoreCode,
  parseStoreBuildNumber,
  parseStorePackageVersion,
  type StoreProductRole,
} from "../../src/shared/store-contracts.js";

export interface StoreInventoryEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface StoreCodeInventory {
  readonly version: 1;
  readonly role: StoreProductRole;
  readonly packageVersion: string;
  readonly protocolAbi: 1;
  readonly appVersion: string;
  readonly buildNumber: number;
  readonly entries: readonly StoreInventoryEntry[];
}
function invalid(): never {
  throw new Error("STORE_INVENTORY_INVALID");
}
const MAX_FILES = 65536,
  MAX_TOTAL = 32 * 1024 ** 3,
  HASH = /^[a-f0-9]{64}$/u;
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export function safeStoreRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1024 ||
    !/^[\x20-\x7e]+$/u.test(value) ||
    /[\\<>:"|?*;$]/u.test(value) ||
    value.startsWith("/")
  )
    invalid();
  if (
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    invalid();
  return value;
}
// Exact wheel-owned Python registry modules and embedded HTML resources.
// JavaScript resources are package data; this grants no execution reference.
const RUNTIME_LIBRARY_RESOURCE_PINS: ReadonlyMap<
  string,
  Readonly<{ bytes: number; sha256: string }>
> = new Map([
  [
    "runtime/python/Lib/site-packages/pip/_vendor/urllib3/contrib/emscripten/emscripten_fetch_worker.js",
    {
      bytes: 3677,
      sha256:
        "cf5937cd9e3f84329ddfeb4def0cf3f0b1e31c2da9c4dfeebbc07793d0fd0377",
    },
  ],
  [
    "runtime/python/Lib/site-packages/sklearn/utils/_repr_html/estimator.js",
    {
      bytes: 6286,
      sha256:
        "bb51d66dec886f0694d382fd378d960f7842245ccdfa373ecd647ea2b11cfd93",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/__init__.py",
    {
      bytes: 1344,
      sha256:
        "1f5f3f7d9667a94007cbf5b1b1bc4a60d24fc7285de5754a0ff1917ca80038ff",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/assume_constant_result.py",
    {
      bytes: 626,
      sha256:
        "ea168b7015841cb6e222553c418108ec6a7d139da3b2dc8f745010cb8e449801",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/autograd_function.py",
    {
      bytes: 647,
      sha256:
        "aae4bfe5f608c3183986a1326d55c31b48648631e86923abca2492f299152601",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/class_method.py",
    {
      bytes: 562,
      sha256:
        "123401857db1a0e7c8ba2715542f75fb8559307284669002bb2fb24a8f24fc77",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_branch_class_method.py",
    {
      bytes: 1417,
      sha256:
        "e1c41b86ac558c2ff2a95e256cb811e6b31a7692d81eaba3b0bc5327ba3c0bfd",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_branch_nested_function.py",
    {
      bytes: 1445,
      sha256:
        "2b31fb0fc1a1633775ffb582da7578e729e57ebcf9a478902a27765087cd912b",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_branch_nonlocal_variables.py",
    {
      bytes: 2001,
      sha256:
        "b7cda918c2b7bca28834ca8904977678367e99b6f02e29cec2014c2a840bb66c",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_closed_over_variable.py",
    {
      bytes: 608,
      sha256:
        "23843d43cea897b8432e1baf9e592a90157d19f5996897b99cb84f796e7c0a80",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_operands.py",
    {
      bytes: 1002,
      sha256:
        "ea99267422becf2413182cc79ad4d7d96592bb51bda31e25771c7cb3efce92b4",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_predicate.py",
    {
      bytes: 803,
      sha256:
        "75f0a794d2f97028a314b596e449329230d5e0b0ad6a5be7dc2fa9de77239f99",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/constrain_as_size_example.py",
    {
      bytes: 766,
      sha256:
        "78c67d9f652bcee02a83d147ff8e58c454ecff378c0bfcaa00d56630b96b5404",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/constrain_as_value_example.py",
    {
      bytes: 820,
      sha256:
        "46d2a91279151901fec126516670b0581670938143783983802c8191c92332ac",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/decorator.py",
    {
      bytes: 556,
      sha256:
        "ca699a762873b02fc30c7ed9396f13d57c0a86af03977aec7669903b2701b4f7",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/dictionary.py",
    {
      bytes: 527,
      sha256:
        "aa28ead13945660e96f8b7534a687619605a93fc93a56beaef67cfa61434c6af",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_assert.py",
    {
      bytes: 566,
      sha256:
        "9216138c200b229f517a151d3d0c7f6bfe024ebd242be5ff0a8f4e639ba5c4ac",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_constructor.py",
    {
      bytes: 504,
      sha256:
        "4aa008a501bb9fc552091ad6ecfdfdac4e2582473ff7446f879542e8cd286aa2",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_if_guard.py",
    {
      bytes: 623,
      sha256:
        "5e752dac10dd3a86fbaad3cb200670b2d1907726c94ee88d9582e08f9515b69b",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_map.py",
    {
      bytes: 574,
      sha256:
        "d99f90d5a691d88c43c2bda3b6717213904c2b4b0a4ed1d76195e098fe5cdc36",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_round.py",
    {
      bytes: 617,
      sha256:
        "dd35ef47d7e02397209f520e87f9046708f23937ff933d12cece2c0dc3043fab",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_slicing.py",
    {
      bytes: 502,
      sha256:
        "d164fae22dfad4ba27972279b4ca78f5885b0538010703d8810094d41b9f692a",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_view.py",
    {
      bytes: 563,
      sha256:
        "f02affff8e39358fb8acba44dbe0b05b3415a4daa36aae7357c27572792e5974",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/fn_with_kwargs.py",
    {
      bytes: 931,
      sha256:
        "8938cf59b322335ab254eb7e1d7bd13fac447dc6d0c065018f672cf919af255c",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/list_contains.py",
    {
      bytes: 598,
      sha256:
        "7b8df086fffc7635626cebcf8cf38f549c2b585d0893d4d8a73be440d6a0232d",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/list_unpack.py",
    {
      bytes: 722,
      sha256:
        "9017bda33b434d3a91839c36dee502d8ca5439cccc2005d102e0b343fcefd69f",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/model_attr_mutation.py",
    {
      bytes: 691,
      sha256:
        "e45b9243dc985e538791580404c1837344b4e80a740bbcb461e57dba4d9bfbae",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/nested_function.py",
    {
      bytes: 616,
      sha256:
        "cf8e16e37e4cd070a6eaee01ff5345406d4584ce9b834a213949cfdd518406b0",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/null_context_manager.py",
    {
      bytes: 599,
      sha256:
        "7a6097af6c2d6f0e2fa669613bb49e2dc63bb447463e5a62d11169ee7d3ec35a",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/optional_input.py",
    {
      bytes: 490,
      sha256:
        "5bf8a4a4d78f69b3e511678dc8fd88f75152274f440c8058eb278bea5d38e5d4",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/pytree_flatten.py",
    {
      bytes: 545,
      sha256:
        "940c0d1ec6122d0f05753e75540d277407054e7f560b4e8e6a44386c47b42357",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/scalar_output.py",
    {
      bytes: 608,
      sha256:
        "e2b21fa257f5c02688bc12d94b47699131c9e76b54f4cc5bc0d7befe0d2639e5",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/specialized_attribute.py",
    {
      bytes: 580,
      sha256:
        "f62396b5dbfacbef0e4baeeea29f8c791f2d69a15e5917ee3ef98f0ca829d95f",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/static_for_loop.py",
    {
      bytes: 534,
      sha256:
        "54aab8f375f59de2179ca181098c7b30a7945a4f57b18a1b23843e1e76c940c9",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/static_if.py",
    {
      bytes: 525,
      sha256:
        "b80bafc19d9ee7dea40651d1905a9800edbc38ec2a356506b6bea1bfbca20c1b",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/tensor_setattr.py",
    {
      bytes: 457,
      sha256:
        "8ca0e4155692e2955398eec99b0dad1e3f990172ffafee01ee71a266f862d313",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/torch_sym_min.py",
    {
      bytes: 446,
      sha256:
        "21a2d223aa1426455e6cb8df086dc79ac45d415cd154e501b61e554ead59d067",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/type_reflection_method.py",
    {
      bytes: 945,
      sha256:
        "1464e33e7469d2a29a12b3b55c6fb35faa5bca147fa362aeeee53c7b92a82715",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/_export/db/examples/user_input_mutation.py",
    {
      bytes: 418,
      sha256:
        "c8b63a47f89015243d5ca923286485be9341a198d5f26d50767bde3fe8c3b2e9",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/utils/model_dump/code.js",
    {
      bytes: 19940,
      sha256:
        "b1c9c5fad55aacd09387de8cd5732480bb71396d478632c3990b9ea414f5ca04",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/utils/model_dump/htm.mjs",
    {
      bytes: 1232,
      sha256:
        "24e71b6de558d9929ba05beb0e496a03ad5f9b780e5146c62291aeaf276c86a3",
    },
  ],
  [
    "runtime/python/Lib/site-packages/torch/utils/model_dump/preact.mjs",
    {
      bytes: 10080,
      sha256:
        "1426fd5ee34aa5c12919fa36564fb45eb7a6fe612310cb801dae3c56227c479c",
    },
  ],
  [
    "runtime/python/Lib/site-packages/urllib3/contrib/emscripten/emscripten_fetch_worker.js",
    {
      bytes: 3677,
      sha256:
        "cf5937cd9e3f84329ddfeb4def0cf3f0b1e31c2da9c4dfeebbc07793d0fd0377",
    },
  ],
]);
function assertRuntimeLibraryResourcePin(
  role: StoreProductRole,
  path: string,
  bytes: number,
  sha256: string,
) {
  const expected =
    role === "worker" ? RUNTIME_LIBRARY_RESOURCE_PINS.get(path) : undefined;
  if (expected && (expected.bytes !== bytes || expected.sha256 !== sha256))
    invalid();
}
function exact(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const proto = Object.getPrototypeOf(value),
    names = Reflect.ownKeys(value),
    result: Record<string, unknown> = Object.create(null);
  if (
    (proto !== Object.prototype && proto !== null) ||
    names.length !== fields.length ||
    names.some((name) => typeof name !== "string" || !fields.includes(name))
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const field of fields) {
    const d = descriptors[field];
    if (!d?.enumerable || !("value" in d)) invalid();
    result[field] = d.value;
  }
  return result;
}
export function parseStoreCodeInventory(value: unknown): StoreCodeInventory {
  const row = exact(value, [
    "version",
    "role",
    "packageVersion",
    "protocolAbi",
    "appVersion",
    "buildNumber",
    "entries",
  ]);
  if (
    row.version !== 1 ||
    (row.role !== "gui" && row.role !== "worker") ||
    row.protocolAbi !== STORE_PROTOCOL_ABI
  )
    invalid();
  const version = parseStorePackageVersion(row.packageVersion, true),
    buildNumber = parseStoreBuildNumber(row.buildNumber);
  if (
    row.appVersion !== version.semanticVersion ||
    row.appVersion !== STORE_PRODUCTS[row.role].appVersion ||
    !Array.isArray(row.entries) ||
    row.entries.length < 1 ||
    row.entries.length > MAX_FILES
  )
    invalid();
  const prefix = row.role === "gui" ? "app/" : "worker/",
    entries: StoreInventoryEntry[] = [],
    seen = new Set<string>();
  let previous = "",
    total = 0;
  for (const value of row.entries) {
    const entry = exact(value, ["path", "bytes", "sha256"]),
      path = safeStoreRelativePath(entry.path);
    if (
      !path.startsWith(prefix) ||
      path <= previous ||
      seen.has(path.toLowerCase()) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0 ||
      (entry.bytes as number) > 4 * 1024 ** 3 ||
      typeof entry.sha256 !== "string" ||
      !HASH.test(entry.sha256) ||
      (entry.bytes === 0 && entry.sha256 !== EMPTY_SHA256)
    )
      invalid();
    const payloadPath = path.slice(prefix.length);
    assertStorePayloadPath(row.role, payloadPath);
    assertRuntimeLibraryResourcePin(
      row.role,
      payloadPath,
      entry.bytes as number,
      entry.sha256 as string,
    );
    previous = path;
    seen.add(path.toLowerCase());
    total += entry.bytes as number;
    if (total > MAX_TOTAL) invalid();
    entries.push(
      Object.freeze({
        path,
        bytes: entry.bytes as number,
        sha256: entry.sha256,
      }),
    );
  }
  return Object.freeze({
    version: 1,
    role: row.role,
    packageVersion: version.text,
    protocolAbi: 1,
    appVersion: row.appVersion as string,
    buildNumber,
    entries: Object.freeze(entries),
  });
}
export function parseStoreCodeInventoryBytes(
  bytes: Uint8Array,
): StoreCodeInventory {
  if (bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 ** 2) invalid();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // A full runtime exceeds the shared parser's total-node bound. Preserve that
    // bound for the header and each row instead of weakening ordinary IPC JSON.
    const whitespace = (at: number) => {
      while (/[\t\n\r ]/u.test(text[at] ?? "x")) at++;
      return at;
    };
    const stringEnd = (start: number) => {
      let at = start + 1;
      while (at < text.length) {
        const c = text[at++]!;
        if (c === '"') return at;
        if (c === "\\") at++;
        else if (c.charCodeAt(0) < 32) invalid();
      }
      return invalid();
    };
    const containerEnd = (start: number) => {
      const stack: string[] = [];
      let at = start;
      while (at < text.length) {
        const c = text[at]!;
        if (c === '"') {
          at = stringEnd(at);
          continue;
        }
        if (c === "{" || c === "[") {
          stack.push(c === "{" ? "}" : "]");
          if (stack.length > 32) invalid();
        } else if (c === "}" || c === "]") {
          if (stack.pop() !== c) invalid();
          if (!stack.length) return at + 1;
        }
        at++;
      }
      return invalid();
    };
    let depth = 0,
      arrayStart = -1,
      arrayEnd = -1;
    for (let at = 0; at < text.length; at++) {
      const c = text[at]!;
      if (c === '"') {
        const end = stringEnd(at);
        if (
          depth === 1 &&
          text[whitespace(end)] === ":" &&
          parseStrictJson(text.slice(at, end), 4096, 16) === "entries"
        ) {
          if (arrayStart !== -1) invalid();
          arrayStart = whitespace(whitespace(end) + 1);
          if (text[arrayStart] !== "[") invalid();
          arrayEnd = containerEnd(arrayStart);
          at = arrayEnd - 1;
          continue;
        }
        at = end - 1;
      } else if (c === "{" || c === "[") {
        if (++depth > 32) invalid();
      } else if (c === "}" || c === "]") depth--;
    }
    if (arrayStart < 0 || depth !== 0) invalid();
    const headerText = text.slice(0, arrayStart) + "[]" + text.slice(arrayEnd);
    const header = exact(parseStrictJson(headerText, 16384, 256), [
      "version",
      "role",
      "packageVersion",
      "protocolAbi",
      "appVersion",
      "buildNumber",
      "entries",
    ]);
    const entries: unknown[] = [];
    let at = whitespace(arrayStart + 1);
    while (at < arrayEnd - 1) {
      if (text[at] !== "{" || entries.length >= MAX_FILES) invalid();
      const end = containerEnd(at);
      if (end - at > 4096 || end > arrayEnd - 1) invalid();
      entries.push(parseStrictJson(text.slice(at, end), 4096, 32));
      at = whitespace(end);
      if (at === arrayEnd - 1) break;
      if (text[at] !== ",") invalid();
      at = whitespace(at + 1);
      if (at === arrayEnd - 1) invalid();
    }
    return parseStoreCodeInventory({ ...header, entries });
  } catch {
    return invalid();
  }
}
export function assertStorePayloadPath(
  role: StoreProductRole,
  value: unknown,
): string {
  if (role !== "gui" && role !== "worker") invalid();
  const path = safeStoreRelativePath(value),
    lower = path.toLowerCase(),
    runtimeResource =
      role === "worker" && RUNTIME_LIBRARY_RESOURCE_PINS.has(path);
  if (
    (!runtimeResource &&
      /(?:^|\/)(?:\.git|\.ssh|\.aws|\.azure|\.env[^/]*|\.npmrc|\.ds_store|\.modules\.yaml|\.pnpm-workspace-state-v1\.json|\.package-lock\.json|tests?|fixtures?|examples?|__pycache__|\.pytest_cache|\.cache|private|vault|outbox|accounts|history)(?:\/|$)/u.test(
        lower,
      )) ||
    /\.(?:map|pyc|pfx|p12|key|credential|sqlite3?|db|log|dmp|onnx|mp3|m4a|mkv|mp4|wav|flac|dylib|so)$/u.test(
      lower,
    ) ||
    /(?:^|\/)(?:machine-credentials|runtime-status|enrollment|worker-config|account-authority-manifest|runtime-metadata|runtime-source|update-channel|app-update-identity)\.json$/u.test(
      lower,
    ) ||
    lower.includes("winsw") ||
    /(?:^|\/)(?:electron-builder|app-builder-lib|dmg-builder|global-agent|roarr|sprintf-js)(?:\/|$)/u.test(
      lower,
    )
  )
    invalid();
  if (
    /\.(?:exe|dll|pyd|node|js|cjs|mjs|py|whl|asar)$/u.test(lower) &&
    !(runtimeResource && /\.(?:js|mjs)$/u.test(path))
  )
    classifyStoreCode(role, path);
  return path;
}
/** File-handle hash with before/after identity checks; never hashes a link alias. */
export async function hashStoreFile(
  path: string,
): Promise<Omit<StoreInventoryEntry, "path">> {
  const named = await lstat(path, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.size < 0n ||
    named.size > 4n * 1024n ** 3n
  )
    invalid();
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat({ bigint: true });
    const same = (s: typeof before) =>
      s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1n &&
      s.dev === before.dev &&
      s.ino === before.ino &&
      s.size === before.size &&
      s.mtimeNs === before.mtimeNs &&
      s.ctimeNs === before.ctimeNs &&
      s.birthtimeNs === before.birthtimeNs;
    if (!same(named)) invalid();
    const buffer = Buffer.alloc(1024 ** 2),
      hash = createHash("sha256");
    let cursor = 0;
    while (cursor < Number(before.size)) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - cursor),
        cursor,
      );
      if (!bytesRead) invalid();
      hash.update(buffer.subarray(0, bytesRead));
      cursor += bytesRead;
    }
    if (
      (await file.read(buffer, 0, 1, cursor)).bytesRead ||
      !same(await file.stat({ bigint: true })) ||
      !same(await lstat(path, { bigint: true }))
    )
      invalid();
    return { bytes: cursor, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}
export async function listStorePayload(
  root: string,
  role: StoreProductRole,
): Promise<StoreInventoryEntry[]> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) invalid();
  const rows: StoreInventoryEntry[] = [];
  const aliases = new Set<string>();
  let total = 0;
  async function walk(directory: string, depth: number) {
    if (depth > 32) invalid();
    for (const name of (await readdir(directory)).sort()) {
      const full = join(directory, name),
        path = relative(root, full).split(sep).join("/");
      safeStoreRelativePath(path);
      if (aliases.has(path.toLowerCase()) || aliases.size >= MAX_FILES)
        invalid();
      aliases.add(path.toLowerCase());
      const s = await lstat(full);
      if (s.isSymbolicLink()) invalid();
      if (s.isDirectory()) await walk(full, depth + 1);
      else {
        assertStorePayloadPath(role, path);
        const pin = await hashStoreFile(full);
        assertRuntimeLibraryResourcePin(role, path, pin.bytes, pin.sha256);
        total += pin.bytes;
        if (total > MAX_TOTAL) invalid();
        rows.push({ path, ...pin });
      }
    }
  }
  await walk(root, 0);
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export async function createStoreCodeInventory(
  root: string,
  role: StoreProductRole,
  packageVersion: string,
  buildNumber: number,
): Promise<StoreCodeInventory> {
  const prefix = role === "gui" ? "app/" : "worker/";
  return parseStoreCodeInventory({
    version: 1,
    role,
    packageVersion,
    protocolAbi: 1,
    appVersion: STORE_PRODUCTS[role].appVersion,
    buildNumber,
    entries: (await listStorePayload(root, role)).map((entry) => ({
      ...entry,
      path: prefix + entry.path,
    })),
  });
}
