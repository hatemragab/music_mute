/** One-operation protected Node entry. Native owns the original child and Job;
 * no PID marker, fork, IPC channel or caller-provided executable is used here. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import {
  parseStoreTransferReply,
  parseStoreTransferRequest,
  snapshotStoreTransferRequest,
  snapshotStoreTransferBytes,
  STORE_TRANSFER_REQUEST_MAX_BYTES,
  type StoreTransferDiagnostic,
  type StoreTransferReply,
  type StoreTransferRequest,
} from "./store-transfer-contracts.js";
import { TransferError, WorkerTransferClient } from "./transfers.js";

function failure(error: unknown, requestId: string): StoreTransferReply {
  let retryable = true,
    diagnostic: StoreTransferDiagnostic = "transfer-process-failed";
  if (
    error &&
    typeof error === "object" &&
    !types.isProxy(error) &&
    error instanceof TransferError
  ) {
    const retry = Object.getOwnPropertyDescriptor(error, "retryable"),
      detail = Object.getOwnPropertyDescriptor(error, "diagnostic");
    if (retry && "value" in retry && typeof retry.value === "boolean")
      retryable = retry.value;
    const value =
      detail && "value" in detail && typeof detail.value === "string"
        ? detail.value
        : "";
    if (value === "file-close-failed")
      diagnostic = "transfer-file-close-failed";
    else if (value === "grant-expired" || value === "download-grant-expired")
      diagnostic = "transfer-grant-expired";
    else if (/^(?:upload|download)-http-[1-5][0-9]{2}$/u.test(value))
      diagnostic = "transfer-http-failed";
    else if (
      value === "download-idle-timeout" ||
      value === "upload-idle-timeout"
    )
      diagnostic = "transfer-idle-timeout";
    else if (
      value === "download-total-timeout" ||
      value === "upload-total-timeout"
    )
      diagnostic = "transfer-total-timeout";
    else if (/^(?:download|upload)-transport-/u.test(value))
      diagnostic = "transfer-transport-failed";
    else if (
      [
        "download-size-mismatch",
        "download-checksum-mismatch",
        "download-content-encoding",
        "download-content-type",
        "output-identity-mismatch",
        "output-checksum-mismatch",
        "output-not-consumed",
        "upload-header-mismatch",
      ].includes(value)
    )
      diagnostic = "transfer-integrity-failed";
  }
  return Object.freeze({
    version: 1,
    requestId,
    ok: false,
    retryable,
    diagnostic,
  });
}

/** This adapter snapshots data before the first await and delegates the unchanged
 * transfer algorithm. Success is an operation result, never retirement proof. */
export async function executeStoreTransferRequest(
  input: StoreTransferRequest,
): Promise<StoreTransferReply> {
  if (!input || typeof input !== "object" || types.isProxy(input))
    throw new TypeError("STORE_TRANSFER_INVALID");
  const workspace = Object.getOwnPropertyDescriptor(input, "workspace");
  if (
    !workspace ||
    !("value" in workspace) ||
    typeof workspace.value !== "string"
  )
    throw new TypeError("STORE_TRANSFER_INVALID");
  const request = snapshotStoreTransferRequest(input, workspace.value);
  try {
    const client = new WorkerTransferClient(request.options);
    const result =
      request.operation === "download"
        ? (await client.download(request.grant, request.expected, request.path),
          null)
        : await client.upload(request.grant, request.path, request.expected);
    // Validate a client result as data before any stdout serialization.
    return parseStoreTransferReply(
      Buffer.from(
        `${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result })}\n`,
      ),
      request.requestId,
      request.operation,
    );
  } catch (error) {
    return failure(error, request.requestId);
  }
}

/** Bounded streaming framing only. Reaching EOF does not certify Native cleanup. */
export async function readStoreTransferRequest(
  input: AsyncIterable<Uint8Array>,
  expectedWorkspace: string,
): Promise<StoreTransferRequest> {
  const chunks: Buffer[] = [];
  let total = 0,
    newline = false;
  for await (const chunk of input) {
    const copy = Buffer.from(
      snapshotStoreTransferBytes(
        chunk,
        STORE_TRANSFER_REQUEST_MAX_BYTES - total,
      ),
    );
    if (copy.length === 0) continue;
    total += copy.length;
    if (
      total > STORE_TRANSFER_REQUEST_MAX_BYTES ||
      (newline && copy.length > 0)
    )
      throw new TypeError("STORE_TRANSFER_INVALID");
    const at = copy.indexOf(10);
    if (at >= 0) {
      if (at !== copy.length - 1 || copy.indexOf(10, at + 1) !== -1)
        throw new TypeError("STORE_TRANSFER_INVALID");
      newline = true;
    }
    chunks.push(copy);
  }
  return parseStoreTransferRequest(
    Buffer.concat(chunks, total),
    expectedWorkspace,
  );
}

async function main(): Promise<void> {
  // A closed stdout must not produce an unhandled stream error/stack trace.
  process.stdout.on("error", () => {
    process.exitCode = 2;
    process.stdin.destroy();
  });
  process.stderr.on("error", () => {
    process.exitCode = 2;
    process.stdin.destroy();
  });
  try {
    if (
      process.platform !== "win32" ||
      process.arch !== "x64" ||
      process.versions.electron !== undefined ||
      process.argv.length !== 3 ||
      process.argv[2] !== "--store-transfer"
    )
      throw new TypeError("STORE_TRANSFER_INVALID");
    // The Creator supplies this fixed child cwd from its retained attempt row.
    // These JavaScript checks supplement, and do not replace, that native binding.
    const timer = setTimeout(
      () => process.stdin.destroy(new Error("STORE_TRANSFER_INVALID")),
      30_000,
    );
    let request: StoreTransferRequest;
    try {
      request = await readStoreTransferRequest(process.stdin, process.cwd());
    } finally {
      clearTimeout(timer);
    }
    const reply = await executeStoreTransferRequest(request);
    await new Promise<void>((done, reject) =>
      process.stdout.write(`${JSON.stringify(reply)}\n`, (error) =>
        error ? reject(error) : done(),
      ),
    );
    process.exitCode = 0;
  } catch {
    // No UUID is invented for an unparsed request, and no path/grant/stack is emitted.
    process.stderr.write("STORE_TRANSFER_INVALID\n");
    process.exitCode = 2;
    process.stdin.destroy();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
