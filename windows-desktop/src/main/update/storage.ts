import { lstat, readdir, rm, rmdir, statfs } from "node:fs/promises";
import { win32 } from "node:path";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { downloadVerifiedArtifact } from "../../../../worker/src/enrollment/artifact-download.js";
import type { HostContext } from "../host-context.js";
import { verifyPrivateFile } from "../prepare/private-files.js";
import type { ConsumerUpdateMetadata } from "../../shared/update-contracts.js";
import {
  consumerUpdateIdentity,
  consumerUpdateUrl,
  type ConsumerUpdateTrust,
} from "./metadata.js";
import {
  parseConsumerUpdateState,
  type ConsumerUpdateStartupState,
  type ConsumerUpdateStore,
} from "./controller.js";

export function createConsumerUpdateStore(
  host: Pick<HostContext, "native">,
): ConsumerUpdateStore {
  return {
    read: async () => {
      const bytes = await host.native.vaultRead(
        "account",
        "consumer_update_state",
      );
      if (!bytes) return null;
      try {
        if (bytes.length > 16384) throw new Error("UPDATE_STATE_INVALID");
        let value: unknown;
        try {
          value = parseStrictJson(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            16384,
          );
        } catch {
          throw new Error("UPDATE_STATE_INVALID");
        }
        return parseConsumerUpdateState(value);
      } finally {
        bytes.fill(0);
      }
    },
    write: async (value) => {
      const bytes = Buffer.from(
        JSON.stringify(parseConsumerUpdateState(value)),
      );
      try {
        await host.native.vaultWrite("account", "consumer_update_state", bytes);
      } finally {
        bytes.fill(0);
      }
    },
  };
}
export interface ConsumerUpdateStartupInspection extends ConsumerUpdateStartupState {
  problem:
    | "UPDATE_RECOVERY_REQUIRED"
    | "UPDATE_STATE_INVALID"
    | "UPDATE_STATE_UNAVAILABLE"
    | null;
}
/** Protect startup even when sealed updater configuration is missing.
 * This only detects durable intent; it cannot authenticate a target or authorize recovery. */
export async function inspectConsumerUpdateStartup(
  host: Pick<HostContext, "native">,
): Promise<ConsumerUpdateStartupInspection> {
  try {
    const state = await createConsumerUpdateStore(host).read(),
      journal = state?.journal;
    if (!journal || ["complete", "rolled-back"].includes(journal.phase))
      return {
        recoveryRequired: false,
        invalidState: false,
        transaction: null,
        problem: null,
      };
    return {
      recoveryRequired: true,
      invalidState: false,
      transaction: journal.transaction,
      problem: "UPDATE_RECOVERY_REQUIRED",
    };
  } catch (error) {
    return {
      recoveryRequired: true,
      invalidState: true,
      transaction: null,
      problem:
        error instanceof SyntaxError ||
        error instanceof TypeError ||
        (error instanceof Error && error.message === "UPDATE_STATE_INVALID")
          ? "UPDATE_STATE_INVALID"
          : "UPDATE_STATE_UNAVAILABLE",
    };
  }
}
/** Only the signed artifact hash chooses a fixed private staging directory. */
export class ConsumerUpdateStager {
  constructor(
    private readonly host: HostContext,
    private readonly trust: ConsumerUpdateTrust,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private relative(metadata: ConsumerUpdateMetadata): string {
    return `updates\\staging\\${consumerUpdateIdentity(metadata)}`;
  }
  async stage(
    metadata: ConsumerUpdateMetadata,
    transaction: string,
    signal: AbortSignal,
    components: readonly ("app" | "runtime" | "model")[] = [
      "app",
      "runtime",
      "model",
    ],
  ): Promise<void> {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        transaction,
      )
    )
      throw new Error("UPDATE_REQUEST_INVALID");
    const relative = this.relative(metadata),
      root = await this.host.native.ensurePrivateDirectory(
        "personal",
        relative,
      );
    const disk = await statfs(root, { bigint: true }),
      required = components
        .map((kind) => metadata[kind])
        .reduce(
          (sum, item) => sum + BigInt(item.artifact.bytes) * 2n,
          1024n ** 3n,
        );
    if (disk.bavail * disk.bsize < required) throw new Error("UPDATE_LOW_DISK");
    for (const kind of components) {
      signal.throwIfAborted();
      const artifact = metadata[kind].artifact;
      consumerUpdateUrl(artifact.url, this.trust.allowedOrigins);
      const name = {
          app: "installer.exe",
          runtime: "runtime.zip",
          model: "model.onnx",
        }[kind],
        path = win32.join(root, name),
        child = `${relative}\\${name}`;
      let exists = false;
      try {
        exists = (await lstat(path)).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (exists) {
        if (
          (await verifyPrivateFile(this.host, child, artifact.bytes, signal))
            .sha256 === artifact.sha256
        )
          continue;
        throw new Error("UPDATE_HASH_INVALID");
      }
      await this.host.native.validatePath("personal", child, "absent");
      // The existing verified downloader checks length/hash, redirect bounds,
      // inactivity, and partial cleanup. Native ACL validation surrounds it.
      await downloadVerifiedArtifact({
        url: artifact.url,
        outputPath: path,
        expectedBytes: artifact.bytes,
        expectedSha256: artifact.sha256,
        expectedContentType: artifact.contentType,
        signal,
        fetch: this.fetcher,
        allowedRedirectHosts: this.trust.allowedOrigins.map(
          (value) => new URL(value).hostname,
        ),
        maxRedirects: 2,
      });
      await this.host.native.validatePath("personal", child, "file");
    }
  }
  async verifyStage(
    metadata: ConsumerUpdateMetadata,
    _transaction: string,
    signal: AbortSignal,
    components: readonly ("app" | "runtime" | "model")[] = [
      "app",
      "runtime",
      "model",
    ],
  ): Promise<void> {
    for (const kind of components) {
      const name = {
          app: "installer.exe",
          runtime: "runtime.zip",
          model: "model.onnx",
        }[kind],
        artifact = metadata[kind].artifact;
      if (
        (
          await verifyPrivateFile(
            this.host,
            `${this.relative(metadata)}\\${name}`,
            artifact.bytes,
            signal,
          )
        ).sha256 !== artifact.sha256
      )
        throw new Error("UPDATE_HASH_INVALID");
    }
  }
  async cleanup(retain: readonly string[], signal: AbortSignal): Promise<void> {
    const relative = "updates\\staging",
      root = await this.host.native.ensurePrivateDirectory(
        "personal",
        relative,
      ),
      entries = await readdir(root);
    if (entries.length > 128) throw new Error("UPDATE_CLEANUP_PENDING");
    for (const id of entries) {
      signal.throwIfAborted();
      if (!/^[a-f0-9]{64}$/u.test(id) || retain.includes(id)) continue;
      const child = `${relative}\\${id}`;
      await this.host.native.validatePath("personal", child, "directory");
      // Never recursively erase unknown files or retained/open media. This
      // directory can contain only three update artifacts owned by this stager.
      const names = await readdir(win32.join(root, id));
      if (
        names.some(
          (name) =>
            !["installer.exe", "runtime.zip", "model.onnx"].includes(name),
        )
      )
        continue;
      for (const name of names) {
        await this.host.native.validatePath(
          "personal",
          `${child}\\${name}`,
          "file",
        );
        await rm(win32.join(root, id, name));
      }
      await rmdir(win32.join(root, id));
    }
  }
}
