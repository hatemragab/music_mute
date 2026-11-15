import { createHash } from "node:crypto";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import type { InstallationArtifactGrant } from "../../../../worker/src/enrollment/enrollment-client.js";
import { TransferBudget } from "../../../../worker/src/enrollment/transfer-budget.js";
import {
  cacheIdentityToWire,
  type ConsumerFileBirth,
  type PrivateReadable,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import {
  transferArtifact,
  type TransferCheckpoint,
} from "../prepare/artifact-transfer.js";
import { PrepareFailure } from "../prepare/controller.js";
import { StorePreparationOperations } from "../prepare/store-operations.js";

const SHA = /^[a-f0-9]{64}$/u;
const MAXIMUM = 64 * 1024 ** 2;
const CHECKPOINT_MAXIMUM = 4096;
interface Options {
  host: HostContext;
  operations: StorePreparationOperations;
  fixture: InstallationArtifactGrant;
  signal: AbortSignal;
  fetch?: typeof fetch;
}
interface FixtureCheckpoint {
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
function grant(input: InstallationArtifactGrant): InstallationArtifactGrant {
  const row = exact(input, [
    "filename",
    "bytes",
    "sha256",
    "contentType",
    "url",
    "expiresAt",
  ]);
  if (
    typeof row.filename !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(row.filename) ||
    !/\.wav$/iu.test(row.filename) ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 44 ||
    (row.bytes as number) > MAXIMUM ||
    typeof row.sha256 !== "string" ||
    !SHA.test(row.sha256) ||
    row.contentType !== "audio/wav" ||
    typeof row.url !== "string" ||
    row.url.length > 8192 ||
    typeof row.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(
      row.expiresAt,
    ) ||
    !Number.isFinite(Date.parse(row.expiresAt)) ||
    Date.parse(row.expiresAt) <= Date.now()
  )
    invalid();
  let url: URL;
  try {
    url = new URL(row.url);
  } catch {
    invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.href !== row.url
  )
    invalid();
  return Object.freeze({
    filename: row.filename,
    bytes: row.bytes as number,
    sha256: row.sha256,
    contentType: "audio/wav",
    url: row.url,
    expiresAt: row.expiresAt,
  });
}
function checkpoint(
  value: unknown,
  binding: string,
  maximum: number,
): FixtureCheckpoint {
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
      (pin.bytes as number) > maximum ||
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
function failures(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      "Store fixture transfer or original resource close was not confirmed",
    );
}
async function held<T>(
  file: PrivateReadable,
  work: () => Promise<T>,
): Promise<T> {
  const errors: unknown[] = [];
  let result!: T;
  try {
    result = await work();
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await file.close();
    } catch (error) {
      errors.push(error);
    }
  }
  failures(errors);
  return result;
}

/** Data only. The original Store operations/native handles remain the owners;
 * a grant, checkpoint or returned digest never grants code, GPU or Ready. */
export async function downloadStoreQualificationFixture(options: Options) {
  const fields = ["host", "operations", "fixture", "signal"];
  if (Object.prototype.hasOwnProperty.call(options, "fetch"))
    fields.push("fetch");
  const row = exact(options, fields),
    host = row.host as HostContext,
    operations = row.operations as StorePreparationOperations,
    signal = row.signal as AbortSignal,
    fetcher = row.fetch as typeof fetch | undefined;
  const assertHost = () =>
    StorePreparationOperations.prototype.assertHost.call(operations, host);
  assertHost();
  if (
    !(signal instanceof AbortSignal) ||
    (fetcher !== undefined && typeof fetcher !== "function") ||
    typeof host.native.openStoreFixtureFile !== "function"
  )
    invalid();
  signal.throwIfAborted();
  const fixture = grant(row.fixture as InstallationArtifactGrant),
    view = await StorePreparationOperations.prototype.mediaCodeView.call(
      operations,
      signal,
    );
  assertHost();
  if (
    view.binding.sid !== host.identity.sid ||
    !SHA.test(view.binding.inventorySha256) ||
    !SHA.test(view.binding.runtimeManifestSha256)
  )
    invalid();
  const currentBinding = JSON.stringify(view.binding),
    binding = createHash("sha256")
      .update(
        JSON.stringify([
          "microsoft-store",
          "approved-qualification-fixture",
          view.binding.package.fullName,
          view.binding.inventorySha256,
          view.binding.runtimeManifestSha256,
          view.binding.sid,
          fixture.sha256,
          fixture.bytes,
        ]),
      )
      .digest("hex"),
    relativePath = `prepare\\approved\\${fixture.sha256}.wav`,
    key = `prepare_fixture_${fixture.sha256.slice(0, 48)}`,
    result = Object.freeze({
      relativePath,
      bytes: fixture.bytes,
      sha256: fixture.sha256,
    });
  const current = async () => {
    signal.throwIfAborted();
    assertHost();
    const after = await StorePreparationOperations.prototype.mediaCodeView.call(
      operations,
      signal,
    );
    assertHost();
    if (JSON.stringify(after.binding) !== currentBinding) invalid();
  };
  assertHost();
  await host.directory("prepare\\approved");
  assertHost();
  let saved: FixtureCheckpoint | null = null;
  const readSaved = async () => {
    assertHost();
    const raw = await host.native.vaultRead("account", key);
    assertHost();
    if (!raw) return null;
    if (raw.length > CHECKPOINT_MAXIMUM) invalid();
    try {
      return checkpoint(
        parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
          CHECKPOINT_MAXIMUM,
          128,
        ),
        binding,
        fixture.bytes,
      );
    } catch {
      invalid();
    }
  };
  let expectedBirth: ConsumerFileBirth | undefined;
  const read = await host.native.openPrivateFile(
    relativePath,
    "read",
    fixture.bytes,
  );
  if (read) {
    const complete = await held(read, async () => {
      assertHost();
      const before = await read.info();
      if (before.bytes > fixture.bytes) invalid();
      if (before.bytes === fixture.bytes) {
        const hash = createHash("sha256");
        for await (const chunk of read.chunks({ signal })) {
          assertHost();
          hash.update(chunk);
        }
        if (
          JSON.stringify(before) !== JSON.stringify(await read.info()) ||
          hash.digest("hex") !== fixture.sha256
        )
          invalid();
        return true;
      }
      saved = await readSaved();
      if (
        !saved ||
        !sameBirth(saved.birth, before) ||
        before.bytes < (saved.checkpoint?.bytes ?? 0) ||
        (before.bytes > 0 && !saved.checkpoint)
      )
        invalid();
      if (JSON.stringify(before) !== JSON.stringify(await read.info()))
        invalid();
      expectedBirth = { ...saved.birth };
      return false;
    });
    if (complete) {
      await current();
      await host.native.vaultDelete("account", key);
      assertHost();
      return result;
    }
  } else {
    saved = await readSaved();
    if (saved) invalid();
  }
  await current();
  const writer = await host.native.openStoreFixtureFile(
    relativePath,
    fixture.bytes,
    expectedBirth,
  );
  const errors: unknown[] = [];
  let closeBody: (() => Promise<void>) | undefined;
  const budget = new TransferBudget(10 * 60_000, 30_000, signal);
  try {
    assertHost();
    const identity = await writer.info(),
      owner = {
        device: identity.device,
        fileId: identity.fileId,
        bornAt: identity.bornAt,
      };
    if (expectedBirth && !sameBirth(owner, expectedBirth)) invalid();
    const writeCheckpoint = async (transfer: TransferCheckpoint | null) => {
      assertHost();
      const value = checkpoint(
          { version: 1, binding, birth: owner, checkpoint: transfer },
          binding,
          fixture.bytes,
        ),
        bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > CHECKPOINT_MAXIMUM) invalid();
      await host.native.vaultWrite("account", key, bytes);
      assertHost();
    };
    if (!expectedBirth) {
      if (identity.bytes !== 0) invalid();
      await writer.sync();
      await writeCheckpoint(null);
    }
    const assertFile = async () => {
      assertHost();
      const info = await writer.info();
      if (!sameBirth(info, owner) || info.bytes > fixture.bytes) invalid();
    };
    await transferArtifact(
      {
        info: () => writer.info(),
        read: async (...args) => {
          const found = await writer.read(...args);
          budget.progress();
          return found;
        },
        write: (...args) => writer.write(...args),
        truncate: (bytes) => writer.truncate(bytes),
        sync: () => writer.sync(),
      },
      {
        binding,
        url: fixture.url,
        bytes: fixture.bytes,
        sha256: fixture.sha256,
      },
      {
        signal: budget.signal,
        assertCurrentFile: assertFile,
        onProgress: () => budget.progress(),
        permittedUrl: (rawUrl, initial) => {
          if (!initial || rawUrl !== fixture.url) invalid();
          return new URL(fixture.url);
        },
        checkpoints: {
          read: async () => saved?.checkpoint ?? null,
          write: writeCheckpoint,
          // Retain even an invalid/interrupted checkpoint until successful
          // bytes, living code binding and original resource close are proven.
          remove: async () => {},
        },
        fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
          assertHost();
          if (
            String(input) !== fixture.url ||
            Date.parse(fixture.expiresAt) <= Date.now()
          )
            invalid();
          const response = await (fetcher ?? fetch)(input, {
            ...init,
            redirect: "error",
            headers: { ...init?.headers, Accept: "audio/wav" },
          });
          budget.progress();
          let closed: Promise<void> | undefined;
          closeBody = () =>
            (closed ??= response.body?.cancel() ?? Promise.resolve());
          if (
            ![200, 206].includes(response.status) ||
            !response.body ||
            response.redirected ||
            (response.url && response.url !== fixture.url) ||
            response.headers
              .get("content-type")
              ?.split(";")[0]
              ?.trim()
              .toLowerCase() !== "audio/wav"
          )
            invalid();
          assertHost();
          const reader = response.body.getReader();
          closeBody = () =>
            (closed ??= reader.cancel().finally(() => reader.releaseLock()));
          const stream = new ReadableStream<Uint8Array>(
            {
              pull: async (controller) => {
                try {
                  const next = await reader.read();
                  assertHost();
                  budget.progress();
                  if (next.done) controller.close();
                  else controller.enqueue(next.value);
                } catch (error) {
                  controller.error(error);
                }
              },
              cancel: () => closeBody!(),
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
    await current();
    await assertFile();
  } catch (error) {
    errors.push(error);
  } finally {
    budget.dispose();
    try {
      await closeBody?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      await writer.close();
    } catch (error) {
      errors.push(error);
    }
  }
  failures(errors);
  await current();
  await host.native.vaultDelete("account", key);
  assertHost();
  return result;
}
