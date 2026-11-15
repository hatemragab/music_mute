import { createHash } from "node:crypto";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { TransferBudget } from "../../../../worker/src/enrollment/transfer-budget.js";
import {
  cacheIdentityToWire,
  type ConsumerFileBirth,
  type PrivateReadable,
  type StoreModelPublication,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { StoreWorkerCodeAuthority } from "../browser/store-native.js";
import type { HostContext } from "../host-context.js";
import {
  transferArtifact,
  type TransferCheckpoint,
} from "./artifact-transfer.js";
import { PrepareFailure } from "./controller.js";
import {
  modelDownloadUrl,
  PREPARATION_TRANSFER_KEYS,
} from "./private-transfer.js";

const SHA = /^[a-f0-9]{64}$/u;
const MAX_CHECKPOINT = 4096;
interface Options {
  host: HostContext;
  code: StoreWorkerCodeAuthority;
  signal: AbortSignal;
  fetch?: typeof fetch;
  onProgress?: (written: number, total: number) => void;
}
interface ModelCheckpoint {
  version: 1;
  binding: string;
  birth: ConsumerFileBirth;
  checkpoint: TransferCheckpoint | null;
}
function invalid(): never {
  throw new PrepareFailure("INTEGRITY_INVALID");
}
function exact(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value),
    names = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    names.length !== fields.length ||
    names.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    row: Record<string, unknown> = Object.create(null);
  for (const name of fields) {
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    row[name] = descriptor.value;
  }
  return row;
}
function birth(value: unknown): ConsumerFileBirth {
  const row = exact(value, ["device", "fileId", "bornAt"]),
    found = {
      device: row.device as string,
      fileId: row.fileId as string,
      bornAt: row.bornAt as string,
    };
  try {
    cacheIdentityToWire(found, "directory");
  } catch {
    invalid();
  }
  return found;
}
function sameBirth(a: ConsumerFileBirth, b: ConsumerFileBirth) {
  return (
    a.device === b.device && a.fileId === b.fileId && a.bornAt === b.bornAt
  );
}
function checkpoint(value: unknown, binding: string): ModelCheckpoint {
  const row = exact(value, ["version", "binding", "birth", "checkpoint"]);
  if (row.version !== 1 || row.binding !== binding) invalid();
  const owner = birth(row.birth);
  let saved: TransferCheckpoint | null = null;
  if (row.checkpoint !== null) {
    const pin = exact(row.checkpoint, [
        "version",
        "binding",
        "bytes",
        "sha256",
        "etag",
        "fingerprint",
      ]),
      fingerprint = exact(pin.fingerprint, ["device", "fileId"]);
    if (
      pin.version !== 1 ||
      pin.binding !== binding ||
      !Number.isSafeInteger(pin.bytes) ||
      (pin.bytes as number) < 1 ||
      (pin.bytes as number) > MODEL.bytes ||
      typeof pin.sha256 !== "string" ||
      !SHA.test(pin.sha256) ||
      typeof pin.etag !== "string" ||
      !/^"[\x21\x23-\x7e]{0,256}"$/u.test(pin.etag) ||
      fingerprint.device !== owner.device ||
      fingerprint.fileId !== owner.fileId
    )
      invalid();
    saved = {
      version: 1,
      binding,
      bytes: pin.bytes as number,
      sha256: pin.sha256,
      etag: pin.etag,
      fingerprint: { device: owner.device, fileId: owner.fileId },
    };
  }
  return { version: 1, binding, birth: owner, checkpoint: saved };
}
function publication(value: StoreModelPublication): StoreModelPublication {
  const row = exact(value, [
    "version",
    "state",
    "identity",
    "sha256",
    "bytes",
    "backupRelativePath",
  ]);
  const identity = exact(row.identity, [
    "device",
    "fileId",
    "bornAt",
    "bytes",
    "writtenAt",
    "changedAt",
  ]) as unknown as StoreModelPublication["identity"];
  try {
    cacheIdentityToWire(identity, "file");
  } catch {
    invalid();
  }
  if (
    row.version !== 1 ||
    (row.state !== "published" && row.state !== "reused") ||
    row.bytes !== MODEL.bytes ||
    row.sha256 !== MODEL.sha256 ||
    identity.bytes !== MODEL.bytes ||
    (row.backupRelativePath !== null &&
      (typeof row.backupRelativePath !== "string" ||
        !/^models\\Kim_Vocal_2\.onnx\.previous-[a-f0-9]{64}$/u.test(
          row.backupRelativePath,
        )))
  )
    invalid();
  return Object.freeze({
    version: 1,
    state: row.state,
    identity: Object.freeze({ ...identity }),
    bytes: MODEL.bytes,
    sha256: MODEL.sha256,
    backupRelativePath: row.backupRelativePath as string | null,
  });
}
function fail(errors: unknown[]): void {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length > 1)
    throw new AggregateError(
      unique,
      "Store model transfer, publication or original resource close was not confirmed",
    );
}
async function withReader<T>(reader: PrivateReadable, work: () => Promise<T>) {
  const errors: unknown[] = [];
  let result!: T;
  try {
    result = await work();
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await reader.close();
    } catch (error) {
      errors.push(error);
    }
  }
  fail(errors);
  return result;
}

/** Root recovers the native publication journal first under the actual Prepare
 * owner. This transfer writes only the fixed model partial, keeps its original
 * writer through native publication, and grants no code, GPU or Ready state. */
export async function downloadStoreModel(
  options: Options,
): Promise<StoreModelPublication> {
  const fields = ["host", "code", "signal"];
  for (const key of ["fetch", "onProgress"])
    if (Object.prototype.hasOwnProperty.call(options, key)) fields.push(key);
  const row = exact(options, fields),
    host = row.host as HostContext,
    code = row.code as StoreWorkerCodeAuthority,
    signal = row.signal as AbortSignal,
    fetcher = row.fetch as typeof fetch | undefined,
    onProgress = row.onProgress as Options["onProgress"];
  const assertOwner = () =>
    StoreWorkerCodeAuthority.prototype.assertDataNative.call(code, host.native);
  assertOwner();
  if (
    !(signal instanceof AbortSignal) ||
    (fetcher !== undefined && typeof fetcher !== "function") ||
    (onProgress !== undefined && typeof onProgress !== "function") ||
    typeof host.native.openStoreModelFile !== "function"
  )
    invalid();
  signal.throwIfAborted();
  const initial =
    await StoreWorkerCodeAuthority.prototype.preparationBinding.call(code);
  assertOwner();
  if (
    initial.sid !== host.identity.sid ||
    !SHA.test(initial.inventorySha256) ||
    !SHA.test(initial.runtimeManifestSha256)
  )
    invalid();
  const currentBinding = JSON.stringify(initial),
    binding = createHash("sha256")
      .update(
        JSON.stringify([
          "microsoft-store",
          "pinned-model-transfer",
          initial.package.fullName,
          initial.inventorySha256,
          initial.runtimeManifestSha256,
          initial.sid,
          MODEL.filename,
          MODEL.bytes,
          MODEL.sha256,
        ]),
      )
      .digest("hex"),
    key = PREPARATION_TRANSFER_KEYS.model;
  const current = async () => {
    signal.throwIfAborted();
    assertOwner();
    const found =
      await StoreWorkerCodeAuthority.prototype.preparationBinding.call(code);
    assertOwner();
    if (JSON.stringify(found) !== currentBinding) invalid();
  };
  const readSaved = async () => {
    assertOwner();
    const raw = await host.native.vaultRead("account", key);
    assertOwner();
    if (!raw) return null;
    if (raw.length > MAX_CHECKPOINT) invalid();
    try {
      return checkpoint(
        parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
          MAX_CHECKPOINT,
          128,
        ),
        binding,
      );
    } catch {
      invalid();
    }
  };
  const writeSaved = async (
    owner: ConsumerFileBirth,
    transfer: TransferCheckpoint | null,
  ) => {
    assertOwner();
    const envelope = checkpoint(
        { version: 1, binding, birth: owner, checkpoint: transfer },
        binding,
      ),
      bytes = Buffer.from(JSON.stringify(envelope));
    if (bytes.length > MAX_CHECKPOINT) invalid();
    await host.native.vaultWrite("account", key, bytes);
    assertOwner();
  };
  await host.directory("models");
  assertOwner();
  let saved: ModelCheckpoint | null = null,
    expectedBirth: ConsumerFileBirth | undefined,
    observedIdentity: string | undefined;
  const reader = await host.native.openPrivateFile(
    "models\\" + MODEL.filename + ".part",
    "read",
    MODEL.bytes,
  );
  if (reader) {
    await withReader(reader, async () => {
      assertOwner();
      const before = await reader.info();
      if (before.bytes > MODEL.bytes) invalid();
      observedIdentity = JSON.stringify(before);
      const owner = birth({
        device: before.device,
        fileId: before.fileId,
        bornAt: before.bornAt,
      });
      if (before.bytes === MODEL.bytes) {
        const hash = createHash("sha256");
        for await (const bytes of reader.chunks({ signal })) {
          assertOwner();
          hash.update(bytes);
        }
        if (
          JSON.stringify(before) !== JSON.stringify(await reader.info()) ||
          hash.digest("hex") !== MODEL.sha256
        )
          invalid();
        // An independently pinned complete partial may adopt its actual birth.
        // Persist this envelope before opening any native writable capability.
        await current();
        await writeSaved(owner, null);
        saved = { version: 1, binding, birth: owner, checkpoint: null };
      } else {
        saved = await readSaved();
        if (
          !saved ||
          !sameBirth(saved.birth, owner) ||
          before.bytes < (saved.checkpoint?.bytes ?? 0) ||
          (before.bytes > 0 && !saved.checkpoint) ||
          JSON.stringify(before) !== JSON.stringify(await reader.info())
        )
          invalid();
      }
      expectedBirth = owner;
    });
  } else {
    saved = await readSaved();
    if (saved) invalid();
  }
  await current();
  const writer = await host.native.openStoreModelFile(expectedBirth),
    errors: unknown[] = [],
    bodyClosers: Array<() => Promise<void>> = [],
    budget = new TransferBudget(10 * 60_000, 30_000, signal);
  let result: StoreModelPublication | undefined;
  const observe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      errors.push(error);
      throw error;
    }
  };
  try {
    assertOwner();
    const first = await writer.info(),
      owner = birth({
        device: first.device,
        fileId: first.fileId,
        bornAt: first.bornAt,
      });
    if (
      expectedBirth
        ? !sameBirth(owner, expectedBirth) ||
          JSON.stringify(first) !== observedIdentity
        : first.bytes !== 0
    )
      invalid();
    if (!expectedBirth) await writeSaved(owner, null);
    const assertFile = async () => {
      assertOwner();
      const found = await writer.info();
      if (!sameBirth(found, owner) || found.bytes > MODEL.bytes) invalid();
    };
    await transferArtifact(
      {
        info: () => observe(() => writer.info()),
        read: (...args) =>
          observe(async () => {
            const found = await writer.read(...args);
            budget.progress();
            return found;
          }),
        write: (...args) => observe(() => writer.write(...args)),
        truncate: (length) => observe(() => writer.truncate(length)),
        sync: () => observe(() => writer.sync()),
      },
      {
        binding,
        url: MODEL.url,
        bytes: MODEL.bytes,
        sha256: MODEL.sha256,
      },
      {
        signal: budget.signal,
        assertCurrentFile: () => observe(assertFile),
        permittedUrl: modelDownloadUrl,
        onProgress: (written, total) => {
          assertOwner();
          budget.progress();
          onProgress?.(written, total);
        },
        checkpoints: {
          read: async () => saved?.checkpoint ?? null,
          write: (checkpoint) => observe(() => writeSaved(owner, checkpoint)),
          // Retain durable ownership until publication, living code and original
          // body/writer closure have all succeeded.
          remove: async () => {},
        },
        fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
          assertOwner();
          const response = await observe(() => (fetcher ?? fetch)(input, init));
          budget.progress();
          let closed: Promise<void> | undefined;
          const body = response.body;
          let close = () => (closed ??= body?.cancel() ?? Promise.resolve());
          bodyClosers.push(() => close());
          if (
            response.redirected ||
            (response.url && response.url !== String(input))
          )
            invalid();
          if (!body) return response;
          const original = body.getReader();
          close = () =>
            (closed ??= original
              .cancel()
              .finally(() => original.releaseLock()));
          const stream = new ReadableStream<Uint8Array>(
            {
              pull: async (controller) => {
                try {
                  const next = await observe(() => original.read());
                  assertOwner();
                  budget.progress();
                  if (next.done) controller.close();
                  else controller.enqueue(next.value);
                } catch (error) {
                  controller.error(error);
                }
              },
              cancel: () => close(),
            },
            { highWaterMark: 0 },
          );
          return new Response(stream, {
            status: response.status,
            headers: response.headers,
          });
        }) as typeof fetch,
      },
    );
    // A network reader that could not close must not precede publication.
    for (const close of bodyClosers) await observe(close);
    await current();
    await assertFile();
    await writer.sync();
    result = publication(await writer.publish());
    if (result.state === "published" && !sameBirth(result.identity, owner))
      invalid();
    await current();
  } catch (error) {
    errors.push(error);
  } finally {
    budget.dispose();
    for (const close of bodyClosers) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await writer.close();
    } catch (error) {
      errors.push(error);
    }
  }
  fail(errors);
  if (!result) invalid();
  await current();
  await host.native.vaultDelete("account", key);
  assertOwner();
  return result;
}
