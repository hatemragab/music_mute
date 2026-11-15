import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseStoreTransferReply,
  type StoreTransferRequest,
} from "../src/runtime/store-transfer-contracts.js";
import {
  executeStoreTransferRequest,
  readStoreTransferRequest,
} from "../src/runtime/store-transfer-process.js";
import {
  TransferError,
  TransferOwnershipError,
  WorkerTransferClient,
} from "../src/runtime/transfers.js";

const requestId = "12345678-1234-4234-8234-123456789012",
  attemptId = "87654321-1234-4234-9234-123456789012";
const workspace = `C:\\Users\\Fixture\\AppData\\Local\\MusicMuteLocal\\cloud\\work\\${attemptId}`,
  sha256 = createHash("sha256").update("fixture").digest("base64");
function download() {
  return {
    version: 1,
    requestId,
    operation: "download",
    attemptId,
    workspace,
    path: win32.join(workspace, "input.mp3"),
    grant: {
      url: "https://fixture.r2.cloudflarestorage.com/input?signature=PRIVATE",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    expected: {
      key: "fixture/input.mp3",
      etag: '"input-etag"',
      bytes: 7,
      sha256,
      contentType: "audio/mpeg",
    },
    options: {},
  };
}
function upload() {
  return {
    ...download(),
    operation: "upload",
    path: win32.join(workspace, "output", "vocals.mp3"),
    expected: { bytes: 7, sha256, contentType: "audio/mpeg" },
    grant: {
      url: "https://fixture.r2.cloudflarestorage.com/output?signature=PRIVATE",
      expiresAt: "2027-01-01T00:00:00.000Z",
      method: "PUT",
      headers: {
        "Content-Type": "audio/mpeg",
        "If-None-Match": "*",
        "x-amz-checksum-sha256": sha256,
        "x-amz-meta-sha256": sha256,
      },
    },
  };
}
const frame = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// These are source/module-boundary tests. Mocked algorithms do not create an
// actual Store Creator, filesystem ownership, R2 object or child-retirement proof.
describe("fixed Store transfer execution", () => {
  it("delegates the unchanged download with a fully detached immutable snapshot", async () => {
    const request = download();
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const downloadMethod = vi
      .spyOn(WorkerTransferClient.prototype, "download")
      .mockImplementation(async (grant, expected, path) => {
        expect(Object.isFrozen(grant)).toBe(true);
        expect(Object.isFrozen(expected)).toBe(true);
        await held;
        expect(grant.url).toContain("/input?");
        expect(expected.bytes).toBe(7);
        expect(path).toBe(win32.join(workspace, "input.mp3"));
      });
    const result = executeStoreTransferRequest(request as StoreTransferRequest);
    request.grant.url = "https://attacker.invalid";
    request.expected.bytes = 99;
    request.path = "C:\\foreign.mp3";
    request.operation = "upload";
    release();
    expect(await result).toEqual({
      version: 1,
      requestId,
      ok: true,
      result: null,
    });
    expect(downloadMethod).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ url: request.grant.url }),
      expect.objectContaining({ bytes: 7 }),
      win32.join(workspace, "input.mp3"),
    );
  });
  it("delegates upload and preserves exact signed headers and a quoted ETag", async () => {
    const request = upload(),
      original = structuredClone(request.grant.headers);
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const uploadMethod = vi
      .spyOn(WorkerTransferClient.prototype, "upload")
      .mockImplementation(async (grant, path, expected) => {
        await held;
        expect(grant.headers).toEqual(original);
        expect(Object.isFrozen(grant.headers)).toBe(true);
        expect(expected).toEqual({
          bytes: 7,
          sha256,
          contentType: "audio/mpeg",
        });
        expect(path).toBe(win32.join(workspace, "output", "vocals.mp3"));
        return '"output-etag"';
      });
    const result = executeStoreTransferRequest(request as StoreTransferRequest);
    request.grant.headers["If-None-Match"] = "changed";
    request.grant.headers["Content-Type"] = "audio/wav";
    release();
    expect(await result).toEqual({
      version: 1,
      requestId,
      ok: true,
      result: '"output-etag"',
    });
    expect(uploadMethod).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["download-grant-expired", "transfer-grant-expired"],
    ["grant-expired", "transfer-grant-expired"],
    ["download-http-403", "transfer-http-failed"],
    ["upload-http-503", "transfer-http-failed"],
    ["download-idle-timeout", "transfer-idle-timeout"],
    ["upload-total-timeout", "transfer-total-timeout"],
    ["download-checksum-mismatch", "transfer-integrity-failed"],
    ["output-not-consumed", "transfer-integrity-failed"],
    ["download-transport-Error-secret", "transfer-transport-failed"],
    ["https://secret.invalid/?credential=PRIVATE", "transfer-process-failed"],
  ])(
    "retains safe classification for %s without forwarding raw diagnostic",
    async (raw, diagnostic) => {
      vi.spyOn(WorkerTransferClient.prototype, "download").mockRejectedValue(
        new TransferError("DOWNLOAD_FAILED", false, raw),
      );
      const reply = await executeStoreTransferRequest(
        download() as StoreTransferRequest,
      );
      expect(reply).toEqual({
        version: 1,
        requestId,
        ok: false,
        retryable: false,
        diagnostic,
      });
      expect(JSON.stringify(reply)).not.toContain("PRIVATE");
      expect(JSON.stringify(reply)).not.toContain("secret.invalid");
      expect(
        parseStoreTransferReply(frame(reply), requestId, "download"),
      ).toEqual(reply);
    },
  );
  it("retains nonretryable original-file closure failure rather than returning success", async () => {
    vi.spyOn(WorkerTransferClient.prototype, "upload").mockRejectedValue(
      new TransferOwnershipError("OUTPUT_UPLOAD_FAILED"),
    );
    expect(
      await executeStoreTransferRequest(upload() as StoreTransferRequest),
    ).toEqual({
      version: 1,
      requestId,
      ok: false,
      retryable: false,
      diagnostic: "transfer-file-close-failed",
    });
  });
  it("does not serialize unknown errors, messages, stacks or accessor hooks", async () => {
    const getter = vi.fn(() => "https://secret.invalid"),
      thrown = {};
    Object.defineProperty(thrown, "retryable", { get: getter });
    Object.defineProperty(thrown, "diagnostic", { get: getter });
    vi.spyOn(WorkerTransferClient.prototype, "download").mockRejectedValue(
      thrown,
    );
    expect(
      await executeStoreTransferRequest(download() as StoreTransferRequest),
    ).toEqual({
      version: 1,
      requestId,
      ok: false,
      retryable: true,
      diagnostic: "transfer-process-failed",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects caller getters and malformed data before constructing an algorithm request", async () => {
    const method = vi.spyOn(WorkerTransferClient.prototype, "download"),
      getter = vi.fn();
    const request = download();
    Object.defineProperty(request.grant, "url", {
      enumerable: true,
      get: getter,
    });
    await expect(
      executeStoreTransferRequest(request as StoreTransferRequest),
    ).rejects.toThrow("STORE_TRANSFER_INVALID");
    expect(getter).not.toHaveBeenCalled();
    expect(method).not.toHaveBeenCalled();
    await expect(
      executeStoreTransferRequest({
        ...download(),
        path: "C:\\foreign.mp3",
      } as StoreTransferRequest),
    ).rejects.toThrow();
  });
  it("cannot forward malformed client success or a reply exceeding its byte budget", async () => {
    const method = vi
      .spyOn(WorkerTransferClient.prototype, "upload")
      .mockResolvedValue("unquoted");
    expect(
      (await executeStoreTransferRequest(upload() as StoreTransferRequest)).ok,
    ).toBe(false);
    method.mockResolvedValue(`"${"\\".repeat(1022)}"`);
    expect(
      (await executeStoreTransferRequest(upload() as StoreTransferRequest)).ok,
    ).toBe(false);
  });
});

describe("Store transfer one-operation stdin", () => {
  it("handles arbitrary UTF8/JSON chunk boundaries and waits for original EOF", async () => {
    const root = workspace.replace("Fixture", "مستخدم🙂"),
      request = {
        ...download(),
        workspace: root,
        path: win32.join(root, "input.mp3"),
      },
      bytes = frame(request);
    let eof!: () => void;
    const eofGate = new Promise<void>((done) => {
      eof = done;
    });
    async function* source() {
      for (const byte of bytes) yield Buffer.from([byte]);
      yield Buffer.alloc(0);
      await eofGate;
    }
    let settled = false;
    const result = readStoreTransferRequest(source(), root).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((done) => setImmediate(done));
    expect(settled).toBe(false);
    eof();
    expect(await result).toEqual(request);
  });
  it.each(["two-lines", "extra-byte", "missing-lf", "crlf"])(
    "rejects %s rather than executing the first frame",
    async (kind) => {
      const bytes = frame(download());
      async function* source() {
        if (kind === "missing-lf") yield bytes.subarray(0, -1);
        else if (kind === "crlf")
          yield Buffer.from(bytes.toString().replace(/\n$/u, "\r\n"));
        else {
          yield bytes;
          yield kind === "two-lines" ? bytes : Buffer.from(" ");
        }
      }
      await expect(
        readStoreTransferRequest(source(), workspace),
      ).rejects.toThrow("STORE_TRANSFER_INVALID");
    },
  );
  it("stops consuming oversize input, positively returning its original iterator", async () => {
    let closed = false,
      reachedExtra = false;
    async function* source() {
      try {
        yield Buffer.alloc(65537, 32);
        reachedExtra = true;
        yield frame(download());
      } finally {
        closed = true;
      }
    }
    await expect(
      readStoreTransferRequest(source(), workspace),
    ).rejects.toThrow();
    expect(closed).toBe(true);
    expect(reachedExtra).toBe(false);
  });
  it("preserves original stdin failure while admitting no transfer request", async () => {
    const failure = new Error("original stdin failed"),
      method = vi.spyOn(WorkerTransferClient.prototype, "download");
    async function* source() {
      yield frame(download()).subarray(0, 10);
      throw failure;
    }
    await expect(readStoreTransferRequest(source(), workspace)).rejects.toBe(
      failure,
    );
    expect(method).not.toHaveBeenCalled();
  });
  it("does not call spoofed typed-view hooks on streamed input", async () => {
    const bytes = frame(download()),
      getter = vi.fn();
    Object.defineProperty(bytes, "valueOf", { value: getter });
    async function* source() {
      yield bytes;
    }
    await expect(
      readStoreTransferRequest(source(), workspace),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

it("actual compiled entry refuses this unsupported local platform without printing input, URLs or a stack", async () => {
  if (process.platform === "win32") return; // This local source check never launches a Windows tool outside the guardian.
  const root = await mkdtemp(join(tmpdir(), "musicmute-store-transfer-entry-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  for (const file of [
    "runtime/store-transfer-contracts",
    "runtime/store-transfer-process",
    "runtime/transfers",
    "runtime/workspace",
    "runtime/transfer-workspace-owner",
    "platform/windows/consumer-strict-json",
  ]) {
    const source = await readFile(
        new URL(`../src/${file}.ts`, import.meta.url),
        "utf8",
      ),
      output = join(root, `${file}.js`);
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
      },
    });
    await mkdir(dirname(output), {
      recursive: true,
    });
    await writeFile(output, compiled.outputText, { flag: "wx" });
  }
  const error = await promisify(execFile)(
    process.execPath,
    [
      await realpath(join(root, "runtime/store-transfer-process.js")),
      "--store-transfer",
    ],
    { env: {}, timeout: 10_000, maxBuffer: 2048 },
  ).catch((value) => value as { code: number; stdout: string; stderr: string });
  expect(error).toMatchObject({
    code: 2,
    stdout: "",
    stderr: "STORE_TRANSFER_INVALID\n",
  });
});
