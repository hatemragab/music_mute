import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadQualificationResult } from "../src/enrollment/qualification-upload.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("qualification result upload", () => {
  it("uploads exact bytes with the signed headers and confirms the version", async () => {
    const payload = Buffer.from("qualified service output");
    const outputPath = await privateOutput(payload);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const checksum = Buffer.from(sha256, "hex").toString("base64");
    const client = {
      qualificationUploadGrant: vi.fn(async () => ({
        requestId: "grant-request",
        reservation: {
          bytes: payload.length,
          sha256,
          contentType: "audio/mpeg" as const,
        },
        grant: {
          method: "PUT" as const,
          url: "https://storage.example.invalid/qualification",
          headers: {
            "Content-Type": "audio/mpeg",
            "x-amz-checksum-sha256": checksum,
            "If-None-Match": "*",
          },
          expiresAt: "2099-09-20T12:00:00.000Z",
        },
        confirmed: false,
      })),
      confirmQualificationUpload: vi.fn(async () => ({
        requestId: "confirm-request",
        confirmed: true as const,
        replayed: false,
      })),
    };
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("PUT");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("If-None-Match")).toBe("*");
        expect(
          Buffer.from(await new Response(init?.body).arrayBuffer()),
        ).toEqual(payload);
        return new Response(null, {
          status: 200,
          headers: { "x-amz-version-id": "version-1" },
        });
      },
    );

    await expect(
      uploadQualificationResult({
        client,
        installationId: "installation-id",
        installationCredential: "credential",
        grantRequestId: "grant-request",
        confirmRequestId: "confirm-request",
        outputPath,
        expectedBytes: payload.length,
        expectedSha256: sha256,
        fetch: fetchMock as typeof fetch,
      }),
    ).resolves.toEqual({
      bytes: payload.length,
      sha256,
      confirmed: true,
      replayed: false,
    });
    expect(client.confirmQualificationUpload).toHaveBeenCalledWith(
      "installation-id",
      "credential",
      "confirm-request",
      "version-1",
    );
  });

  it("does not confirm a PUT that stalls after consuming its body", async () => {
    const payload = Buffer.from("qualified service output");
    const outputPath = await privateOutput(payload);
    const client = {
      qualificationUploadGrant: vi.fn(async () => ({
        requestId: "grant-request",
        reservation: {
          bytes: payload.length,
          sha256: createHash("sha256").update(payload).digest("hex"),
          contentType: "audio/mpeg" as const,
        },
        grant: {
          method: "PUT" as const,
          url: "https://storage.example.invalid/qualification",
          headers: { "Content-Type": "audio/mpeg" },
          expiresAt: "2099-09-20T12:00:00.000Z",
        },
        confirmed: false,
      })),
      confirmQualificationUpload: vi.fn(),
    };
    const fetchMock: typeof fetch = async (_url, init) => {
      await new Response(init?.body).arrayBuffer();
      const signal = init?.signal;
      if (!signal) throw new Error("Missing cancellation");
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    await expect(
      uploadQualificationResult({
        client,
        installationId: "installation-id",
        installationCredential: "credential",
        grantRequestId: "grant-request",
        confirmRequestId: "confirm-request",
        outputPath,
        expectedBytes: payload.length,
        expectedSha256: createHash("sha256").update(payload).digest("hex"),
        fetch: fetchMock,
        idleTimeoutMs: 1000,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("inactivity timeout");
    expect(client.confirmQualificationUpload).not.toHaveBeenCalled();
  });

  it("recovers an already confirmed upload without another PUT", async () => {
    const payload = Buffer.from("qualified service output");
    const outputPath = await privateOutput(payload);
    const client = {
      qualificationUploadGrant: vi.fn(async () => ({
        requestId: "grant-request",
        reservation: {
          bytes: payload.length,
          sha256: createHash("sha256").update(payload).digest("hex"),
          contentType: "audio/mpeg" as const,
        },
        grant: null,
        confirmed: true,
      })),
      confirmQualificationUpload: vi.fn(),
    };
    const fetchMock = vi.fn();

    await expect(
      uploadQualificationResult({
        client,
        installationId: "installation-id",
        installationCredential: "credential",
        grantRequestId: "grant-request",
        confirmRequestId: "confirm-request",
        outputPath,
        expectedBytes: payload.length,
        expectedSha256: createHash("sha256").update(payload).digest("hex"),
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ confirmed: true, replayed: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.confirmQualificationUpload).not.toHaveBeenCalled();
  });

  it("rejects unsafe result files before requesting a grant", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "musicmute-qualification-upload-"),
    );
    roots.push(root);
    const outputPath = join(root, "qualification.mp3");
    await writeFile(outputPath, "unsafe", { mode: 0o644 });
    await chmod(outputPath, 0o644);
    const client = {
      qualificationUploadGrant: vi.fn(),
      confirmQualificationUpload: vi.fn(),
    };

    if (process.platform !== "win32")
      await expect(
        uploadQualificationResult({
          client,
          installationId: "installation-id",
          installationCredential: "credential",
          grantRequestId: "grant-request",
          confirmRequestId: "confirm-request",
          outputPath,
          expectedBytes: 6,
          expectedSha256: createHash("sha256").update("unsafe").digest("hex"),
        }),
      ).rejects.toThrow("file is unsafe");
    expect(client.qualificationUploadGrant).not.toHaveBeenCalled();
  });

  it("rejects a result changed after service qualification", async () => {
    const payload = Buffer.from("changed output");
    const outputPath = await privateOutput(payload);
    const client = {
      qualificationUploadGrant: vi.fn(),
      confirmQualificationUpload: vi.fn(),
    };

    await expect(
      uploadQualificationResult({
        client,
        installationId: "installation-id",
        installationCredential: "credential",
        grantRequestId: "grant-request",
        confirmRequestId: "confirm-request",
        outputPath,
        expectedBytes: payload.length,
        expectedSha256: "a".repeat(64),
      }),
    ).rejects.toThrow("does not match service evidence");
    expect(client.qualificationUploadGrant).not.toHaveBeenCalled();
  });
});

async function privateOutput(payload: Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-qualification-upload-"));
  roots.push(root);
  const path = join(root, "qualification.mp3");
  await writeFile(path, payload, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
