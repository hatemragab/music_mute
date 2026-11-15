import { lstat, readdir } from "node:fs/promises";
import { win32 } from "node:path";
import type { ConsumerOwnedProcess } from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  parseStoreCpuOperationExpectation,
  type StoreCpuOperationExpectation,
} from "../../../../worker/src/platform/windows/consumer-store-cpu.js";
import {
  assertConsumerNonce,
  assertConsumerRelativePath,
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import type { HostContext } from "../host-context.js";
import {
  privateFingerprint,
  readPrivateBytes,
} from "../prepare/private-files.js";
import type { StorageCategory } from "../../shared/storage-contracts.js";
import type { StorageFile, StorageItem } from "./model.js";
import { parsePersonalPair } from "../reuse/pair.js";
import type { WindowsStorageWriteJournal } from "./write-journal.js";
import { partialWriteTarget } from "./partial-write-policy.js";
import { retireStorageWorkspaceMarker } from "./native-cleanup.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { parseStorageAccessIndex } from "../library/pins.js";
const UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  HASH = /^[a-f0-9]{64}$/u;
interface Node {
  relative: string;
  files: StorageFile[];
  directories: string[];
  births?: StorageItem["births"];
  bytes: number;
  modified: number;
}
export interface StorageWorkspace {
  version: 1;
  relativePath: string;
  owner: ConsumerOwnedProcess;
  purpose: "processing" | "download" | "update" | "sync";
  createdAt: number;
}
export interface StoreCpuStorageWorkspace {
  version: 2;
  relativePath: string;
  owner: StoreCpuOperationExpectation;
  purpose: "processing";
  createdAt: number;
}
export type AnyStorageWorkspace = StorageWorkspace | StoreCpuStorageWorkspace;
export function parseStoreCpuWorkspace(
  value: unknown,
  hostSid: string,
): StoreCpuStorageWorkspace {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("STORAGE_WORKSPACE_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    keys.length !== 5 ||
    keys.some(
      (k) =>
        typeof k !== "string" ||
        !["version", "relativePath", "owner", "purpose", "createdAt"].includes(
          k,
        ),
    ) ||
    keys.some(
      (k) =>
        !descriptors[k as string]?.enumerable ||
        !("value" in descriptors[k as string]!),
    )
  )
    throw new Error("STORAGE_WORKSPACE_INVALID");
  const row = value as StoreCpuStorageWorkspace,
    owner = parseStoreCpuOperationExpectation(descriptors.owner!.value);
  const relative = `${owner.operation === "silence_analyze" ? "prepare" : "cloud"}\\work\\${owner.requestId}`;
  if (
    row.version !== 2 ||
    row.purpose !== "processing" ||
    row.relativePath !== relative ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt < 0 ||
    owner.nodeOwner.identity.sid !== hostSid
  )
    throw new Error("STORAGE_WORKSPACE_INVALID");
  return Object.freeze({
    version: 2,
    relativePath: relative,
    owner,
    purpose: "processing",
    createdAt: row.createdAt,
  });
}
export function parseAnyWorkspace(
  value: unknown,
  sid: string,
): AnyStorageWorkspace {
  return value &&
    typeof value === "object" &&
    Object.getOwnPropertyDescriptor(value, "version")?.value === 2
    ? parseStoreCpuWorkspace(value, sid)
    : parseWorkspace(value, sid);
}
export async function workspaceExited(
  host: HostContext,
  treeExited: (owner: ConsumerOwnedProcess) => Promise<boolean>,
  row: AnyStorageWorkspace,
): Promise<boolean> {
  if (row.version === 1) return treeExited(row.owner);
  if (!host.native.inspectStoreCpuOperation)
    throw new Error("STORAGE_RECOVERY_PENDING");
  const retired = await host.native.inspectStoreCpuOperation(row.owner);
  if (typeof retired !== "boolean") throw new Error("STORAGE_RECOVERY_PENDING");
  return retired;
}
export function parseWorkspace(
  value: unknown,
  hostSid: string,
): StorageWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("STORAGE_WORKSPACE_INVALID");
  const row = value as StorageWorkspace;
  if (
    Object.keys(row).sort().join() !==
      "createdAt,owner,purpose,relativePath,version" ||
    row.version !== 1 ||
    !row.owner ||
    Object.keys(row.owner).sort().join() !== "identity,nonce,role" ||
    !["personal", "fleet", "prepare", "session-agent"].includes(
      row.owner.role,
    ) ||
    !["processing", "download", "update", "sync"].includes(row.purpose) ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt < 0
  )
    throw new Error("STORAGE_WORKSPACE_INVALID");
  assertConsumerRelativePath(row.relativePath);
  assertConsumerNonce(row.owner.nonce);
  const identity = processIdentityFromWire(
    processIdentityToWire(row.owner.identity),
  );
  if (identity.sid !== hostSid) throw new Error("STORAGE_WORKSPACE_INVALID");
  if (
    !/^(?:personal\\(?:jobs|inputs|engine-session)\\[a-f0-9-]{36}|cloud\\work\\[a-f0-9-]{36}|prepare\\(?:work|downloads)\\[a-f0-9-]{36})$/u.test(
      row.relativePath,
    )
  )
    throw new Error("STORAGE_WORKSPACE_INVALID");
  if (
    row.relativePath.startsWith("personal\\engine-session\\") &&
    (row.owner.role !== "personal" ||
      row.purpose !== "processing" ||
      !UUID.test(row.relativePath.split("\\").at(-1)!))
  )
    throw new Error("STORAGE_WORKSPACE_INVALID");
  return structuredClone({ ...row, owner: { ...row.owner, identity } });
}
/** Bounded native-validated inventory. Runtime, models, outboxes and unrecognized data are never eligible. */
export class WindowsStorageInventory {
  constructor(
    private readonly host: HostContext,
    private readonly treeExited: (
      owner: ConsumerOwnedProcess,
    ) => Promise<boolean>,
    private readonly activeRuntimeRoots: () => Promise<
      ReadonlySet<string>
    > = async () => new Set(),
    private readonly writes?: WindowsStorageWriteJournal,
    private readonly additionalWorkspaces: () => Promise<
      StorageWorkspace[]
    > = async () => [],
  ) {}
  /** Caller has positively stopped its retained engine before this exact private cache census. */
  async exitedSessionWorkspace(
    relative: string,
    signal: AbortSignal,
  ): Promise<StorageItem> {
    if (!/^personal\\engine-session\\[a-f0-9-]{36}$/u.test(relative))
      throw new Error("STORAGE_WORKSPACE_INVALID");
    return this.item(
      await this.tree(relative, signal),
      "scratch",
      true,
      new Map(),
    );
  }
  private async exists(relative: string): Promise<boolean> {
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async directory(relative: string): Promise<string[]> {
    if (!(await this.exists(relative))) return [];
    await this.host.native.validatePath("personal", relative, "directory");
    const names = await readdir(win32.join(this.host.personalRoot, relative));
    if (
      names.length > 32768 ||
      names.some(
        (name) => /[\\/:\p{Cc}]/u.test(name) || name === "." || name === "..",
      )
    )
      throw new Error("STORAGE_UNSAFE");
    return names;
  }
  private async tree(relative: string, signal: AbortSignal): Promise<Node> {
    const root: Node = {
        relative,
        files: [],
        directories: [],
        births: {},
        bytes: 0,
        modified: 0,
      },
      pending = [{ relative, depth: 0 }];
    let count = 0;
    while (pending.length) {
      signal.throwIfAborted();
      const current = pending.pop()!;
      if (++count > 100000 || current.depth > 32)
        throw new Error("STORAGE_INVENTORY_LIMIT");
      const stat = await lstat(
        win32.join(this.host.personalRoot, current.relative),
        { bigint: true },
      );
      if (stat.isSymbolicLink()) throw new Error("STORAGE_UNSAFE");
      root.modified = Math.max(root.modified, Number(stat.mtimeMs));
      if (stat.ino === 0n || stat.birthtimeNs <= 0n)
        throw new Error("STORAGE_UNSAFE");
      root.births![current.relative] = {
        device: String(stat.dev),
        fileId: String(stat.ino),
        bornAt: String(stat.birthtimeNs),
      };
      if (stat.isDirectory()) {
        await this.host.native.validatePath(
          "personal",
          current.relative,
          "directory",
        );
        root.directories.push(current.relative);
        for (const name of await this.directory(current.relative))
          pending.push({
            relative: `${current.relative}\\${name}`,
            depth: current.depth + 1,
          });
      } else if (stat.isFile() && stat.nlink === 1n) {
        const fingerprint = await privateFingerprint(
          this.host,
          current.relative,
        );
        root.files.push({ relativePath: current.relative, fingerprint });
        root.bytes += fingerprint.bytes;
        if (!Number.isSafeInteger(root.bytes))
          throw new Error("STORAGE_INVENTORY_LIMIT");
      } else throw new Error("STORAGE_UNSAFE");
    }
    return root;
  }
  private async access(): Promise<Map<string, number>> {
    const relative = "storage\\access.json";
    if (!(await this.exists(relative))) return new Map();
    // I/O/ownership failures stay outside the parser's advisory-corruption class.
    const entries = parseStorageAccessIndex(
      await readPrivateBytes(this.host, relative, 1024 ** 2),
    );
    return new Map(entries.map((entry) => [entry.relativePath, entry.at]));
  }
  private item(
    node: Node,
    category: StorageCategory,
    eligible: boolean,
    access: ReadonlyMap<string, number>,
  ): StorageItem {
    return {
      id: `${category}:${node.relative}`,
      relativePath: node.relative,
      category,
      bytes: node.bytes,
      lastUsed: Math.max(
        node.modified,
        access.get(node.relative) ?? 0,
        ...node.files.map((file) => access.get(file.relativePath) ?? 0),
      ),
      eligible,
      files: node.files,
      directories: node.directories,
      births: node.births,
    };
  }
  /** Caller owns the cache mutex; absent data alone never substitutes for a native exit certificate. */
  async pruneWorkspaceMarkersOwned(signal: AbortSignal): Promise<void> {
    for (const name of await this.directory("storage\\workspaces")) {
      signal.throwIfAborted();
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const relative = `storage\\workspaces\\${name}`,
        row = parseAnyWorkspace(
          parseStrictJson(
            new TextDecoder("utf-8", { fatal: true }).decode(
              await readPrivateBytes(this.host, relative, 2048),
            ),
          ),
          this.host.identity.sid,
        );
      if (await this.exists(row.relativePath)) continue;
      let exited = false;
      try {
        exited = await workspaceExited(this.host, this.treeExited, row);
      } catch {
        /* Retain uncertainty. */
      }
      if (exited) {
        await retireStorageWorkspaceMarker(
          this.host,
          row.relativePath,
          row.owner,
        );
      }
    }
  }
  async scan(signal: AbortSignal, full = true): Promise<StorageItem[]> {
    const items: StorageItem[] = [],
      access = await this.access(),
      writeTargets = ((await this.writes?.targetsOwned(signal)) ?? []).filter(
        (row) => !partialWriteTarget(row.relativePath),
      ),
      written = new Set(writeTargets.map((row) => row.relativePath));
    for (const row of writeTargets) {
      const node = await this.tree(row.relativePath, signal);
      items.push(this.item(node, "scratch", row.eligible, access));
    }
    for (const name of await this.directory("personal\\results")) {
      const relative = `personal\\results\\${name}`,
        node = await this.tree(relative, signal);
      if (written.has(relative)) continue;
      if (!UUID.test(name)) {
        items.push(this.item(node, "unmanaged", false, access));
        continue;
      }
      const pairPath = `${relative}\\pair.json`;
      if (!(await this.exists(pairPath))) {
        items.push(this.item(node, "unmanaged", false, access));
        continue;
      }
      const pair = JSON.parse(
        (await readPrivateBytes(this.host, pairPath, 16384)).toString("utf8"),
      ) as {
        version: number;
        jobId: string;
        original: Record<string, unknown>;
        vocals: Record<string, unknown>;
        timeline?: unknown;
        reuseReceipt?: unknown;
        completionReceipt?: unknown;
      };
      if (
        Object.keys(pair).some(
          (key) =>
            ![
              "jobId",
              "original",
              "version",
              "vocals",
              "timeline",
              "reuseReceipt",
              "completionReceipt",
              "source",
            ].includes(key),
        ) ||
        pair.version !== 1 ||
        pair.jobId !== name
      )
        throw new Error("STORAGE_MEDIA_INVALID");
      parsePersonalPair(pair, this.host.report.installationId, name);
      const recognized = new Set([pairPath]);
      for (const [kind, category] of [
        ["vocals", "voices"],
        ["original", "originals"],
      ] as const) {
        const artifact = pair[kind];
        if (
          !artifact ||
          Object.keys(artifact).sort().join() !==
            "bytes,contentType,durationSeconds,filename,id,kind,name,sha256" ||
          !UUID.test(String(artifact.id)) ||
          artifact.kind !== kind ||
          !HASH.test(String(artifact.sha256)) ||
          !Number.isSafeInteger(artifact.bytes) ||
          Number(artifact.bytes) < 1 ||
          Number(artifact.bytes) > 256 * 1024 ** 2 ||
          typeof artifact.filename !== "string" ||
          !(kind === "vocals"
            ? artifact.filename === "vocals.mp3"
            : /^original\.(?:mp3|m4a|mp4|webm|opus|ogg|aac|wav|flac)$/u.test(
                artifact.filename,
              ))
        )
          throw new Error("STORAGE_MEDIA_INVALID");
        const filePath = `${relative}\\${artifact.filename}`,
          file = node.files.find((file) => file.relativePath === filePath);
        recognized.add(filePath);
        if (file) {
          if (file.fingerprint.bytes !== artifact.bytes)
            throw new Error("STORAGE_MEDIA_INVALID");
          items.push(
            this.item(
              {
                relative: filePath,
                files: [file],
                directories: [],
                bytes: file.fingerprint.bytes,
                modified: node.modified,
                births: node.births,
              },
              category,
              true,
              access,
            ),
          );
        }
      }
      const other = node.files.filter(
        (file) => !recognized.has(file.relativePath),
      );
      if (other.length)
        items.push(
          this.item(
            {
              relative,
              files: other,
              directories: [],
              bytes: other.reduce(
                (sum, file) => sum + file.fingerprint.bytes,
                0,
              ),
              modified: node.modified,
              births: node.births,
            },
            "unmanaged",
            false,
            access,
          ),
        );
      const meta = node.files.find((file) => file.relativePath === pairPath)!;
      items.push(
        this.item(
          {
            relative: pairPath,
            files: [meta],
            directories: [],
            bytes: meta.fingerprint.bytes,
            modified: node.modified,
            births: node.births,
          },
          "metadata",
          false,
          access,
        ),
      );
    }
    for (const owner of await this.directory("library\\media"))
      for (const job of await this.directory(`library\\media\\${owner}`))
        for (const variant of await this.directory(
          `library\\media\\${owner}\\${job}`,
        ))
          for (const digest of await this.directory(
            `library\\media\\${owner}\\${job}\\${variant}`,
          )) {
            const relative = `library\\media\\${owner}\\${job}\\${variant}\\${digest}`,
              node = await this.tree(relative, signal),
              category = variant === "voice" ? "voices" : "originals";
            node.files = node.files.filter(
              (file) => !written.has(file.relativePath),
            );
            node.bytes = node.files.reduce(
              (sum, file) => sum + file.fingerprint.bytes,
              0,
            );
            if (
              !HASH.test(owner) ||
              !/^[a-f0-9]{24}$/u.test(job) ||
              !["voice", "original"].includes(variant) ||
              !HASH.test(digest) ||
              !(await this.exists(`${relative}\\media.json`))
            ) {
              items.push(this.item(node, category, false, access));
              continue;
            }
            const row = JSON.parse(
              (
                await readPrivateBytes(
                  this.host,
                  `${relative}\\media.json`,
                  4096,
                )
              ).toString("utf8"),
            ) as Record<string, unknown>;
            if (
              row.version !== 1 ||
              row.jobId !== job ||
              row.variant !== variant ||
              row.sha256 !== digest ||
              typeof row.ownerUid !== "string" ||
              typeof row.relativePath !== "string" ||
              !row.relativePath.startsWith(`${relative}\\media.`) ||
              !UUID.test(String(row.artifactId))
            )
              throw new Error("STORAGE_MEDIA_INVALID");
            const expected = new Set([
              `${relative}\\media.json`,
              row.relativePath,
            ]);
            if (
              node.files.some((file) => !expected.has(file.relativePath)) ||
              node.directories.length !== 1
            ) {
              items.push(this.item(node, category, false, access));
              continue;
            }
            const data = node.files.find(
              (file) => file.relativePath === row.relativePath,
            );
            if (data && data.fingerprint.bytes !== row.bytes)
              throw new Error("STORAGE_MEDIA_INVALID");
            node.files.sort(
              (a, b) =>
                Number(a.relativePath.endsWith("media.json")) -
                Number(b.relativePath.endsWith("media.json")),
            );
            items.push(this.item(node, category, true, access));
          }
    for (const name of await this.directory("library\\thumbnails")) {
      const node = await this.tree(`library\\thumbnails\\${name}`, signal);
      items.push(
        this.item(
          node,
          "thumbnails",
          /^[a-f0-9]{64}\.image$/u.test(name) &&
            node.files.length === 1 &&
            node.directories.length === 0,
          access,
        ),
      );
    }
    if (!full) return items;
    const markers = new Map<string, AnyStorageWorkspace>();
    for (const name of await this.directory("storage\\workspaces")) {
      if (!HASH.test(name.replace(/\.json$/u, "")) || !name.endsWith(".json"))
        continue;
      const row = parseAnyWorkspace(
        parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readPrivateBytes(
              this.host,
              `storage\\workspaces\\${name}`,
              2048,
            ),
          ),
        ),
        this.host.identity.sid,
      );
      markers.set(row.relativePath, row);
    }
    for (const value of await this.additionalWorkspaces()) {
      const row = parseAnyWorkspace(value, this.host.identity.sid);
      markers.set(row.relativePath, row);
    }
    for (const base of [
      "personal\\jobs",
      "personal\\engine-session",
      "personal\\inputs",
      "cloud\\work",
      "prepare\\work",
      "prepare\\downloads",
    ]) {
      for (const name of await this.directory(base)) {
        if (written.has(`${base}\\${name}`)) continue;
        const node = await this.tree(`${base}\\${name}`, signal),
          marker = markers.get(node.relative);
        let eligible = false;
        if (marker) {
          try {
            eligible = await workspaceExited(
              this.host,
              this.treeExited,
              marker,
            );
          } catch {
            /* Uncertainty never authorizes descendant cleanup. */
          }
        }
        items.push(this.item(node, "scratch", eligible, access));
      }
    }
    const runtimeRoots = await this.activeRuntimeRoots();
    for (const relative of [
      "prepare\\readiness",
      "prepare\\runtime-status",
      "staging\\prepare-runtime-backup",
      "staging\\prepare-runtime-backup.inventory.json",
    ]) {
      if (!(await this.exists(relative))) continue;
      const node = await this.tree(relative, signal);
      items.push(
        this.item(
          node,
          relative === "staging\\prepare-runtime-backup"
            ? "rollback"
            : "metadata",
          false,
          access,
        ),
      );
    }
    for (const name of await this.directory("runtime\\releases")) {
      const relative = `runtime\\releases\\${name}`,
        node = await this.tree(relative, signal);
      items.push(
        this.item(
          node,
          runtimeRoots.size && !runtimeRoots.has(relative)
            ? "rollback"
            : "runtime",
          false,
          access,
        ),
      );
    }
    for (const [relative, category] of [
      ["models", "models"],
      ["outbox", "outbox"],
      ["cloud\\outputs", "scratch"],
      ["personal\\exports", "metadata"],
      ["logs", "metadata"],
      ["diagnostics\\reports", "metadata"],
    ] as const) {
      if (await this.exists(relative))
        items.push(
          this.item(await this.tree(relative, signal), category, false, access),
        );
    }
    return items;
  }
}
