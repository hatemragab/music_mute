import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadInstallationArtifacts,
  downloadVerifiedArtifact,
} from "../src/enrollment/artifact-download.js";
import type { InstallationArtifactsResult } from "../src/enrollment/enrollment-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("verified enrollment artifact downloads", () => {
  it("downloads the complete approved installation set into a protected root", async () => {
    const root = await protectedRoot();
    const payloads = {
      release: Buffer.from("release"),
      model: Buffer.from("model"),
      fixture: Buffer.from("fixture"),
    };
    const manifest = installationManifest(payloads);
    const requests: string[] = [];
    const fetchMock = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const name = url.pathname.slice(1) as keyof typeof payloads;
      const payload = payloads[name];
      if (payload === undefined) return new Response(null, { status: 404 });
      requests.push(name);
      const artifact =
        name === "release"
          ? manifest.release
          : name === "model"
            ? manifest.model
            : manifest.fixture;
      return new Response(payload, {
        headers: {
          "Content-Length": String(payload.length),
          "Content-Type": artifact.contentType,
        },
      });
    };

    const result = await downloadInstallationArtifacts(manifest, {
      outputRoot: root,
      fetch: fetchMock as typeof fetch,
    });

    expect(requests).toEqual(["release", "model", "fixture"]);
    expect(result.release.reused).toBe(false);
    expect(result.model.reused).toBe(false);
    expect(result.fixture.reused).toBe(false);
    expect(await readFile(join(root, manifest.release.filename))).toEqual(
      payloads.release,
    );
    expect(await readFile(join(root, manifest.model.filename))).toEqual(
      payloads.model,
    );
    expect(await readFile(join(root, manifest.fixture.filename))).toEqual(
      payloads.fixture,
    );
  });

  it("rejects expired or path-like installation grants before network access", async () => {
    const root = await protectedRoot();
    const payloads = {
      release: Buffer.from("release"),
      model: Buffer.from("model"),
      fixture: Buffer.from("fixture"),
    };
    const expired = installationManifest(payloads);
    expired.model.expiresAt = "2020-01-01T00:00:00.000Z";
    const fetchMock = async () => new Response();

    await expect(
      downloadInstallationArtifacts(expired, {
        outputRoot: root,
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow("grant is expired");

    const unsafe = installationManifest(payloads);
    unsafe.fixture.filename = "../fixture.wav";
    await expect(
      downloadInstallationArtifacts(unsafe, {
        outputRoot: root,
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow("filename is unsafe");
  });

  it("streams, verifies and safely reuses an exact artifact", async () => {
    const payload = Buffer.from("owned qualification fixture\n".repeat(1024));
    const digest = createHash("sha256").update(payload).digest("hex");
    const root = await protectedRoot();
    const outputPath = join(root, "fixture.wav");
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, {
        "Content-Length": payload.length,
        "Content-Type": "audio/wav",
      });
      response.end(payload);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture server address is unavailable");
    const options = {
      url: `http://127.0.0.1:${address.port}/fixture`,
      outputPath,
      expectedBytes: payload.length,
      expectedSha256: digest,
      expectedContentType: "audio/wav",
      allowInsecureLoopback: true,
    };
    try {
      await expect(downloadVerifiedArtifact(options)).resolves.toMatchObject({
        reused: false,
        bytes: payload.length,
        sha256: digest,
      });
      await expect(downloadVerifiedArtifact(options)).resolves.toMatchObject({
        reused: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(requests).toBe(1);
    expect(await readFile(outputPath)).toEqual(payload);
  });

  it("removes a partial file when the body digest is wrong", async () => {
    const expected = Buffer.from("expected");
    const actual = Buffer.from("tampered");
    const root = await protectedRoot();
    const outputPath = join(root, "model.onnx");
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Length": actual.length,
        "Content-Type": "application/octet-stream",
      });
      response.end(actual);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture server address is unavailable");
    try {
      await expect(
        downloadVerifiedArtifact({
          url: `http://127.0.0.1:${address.port}/model`,
          outputPath,
          expectedBytes: actual.length,
          expectedSha256: createHash("sha256").update(expected).digest("hex"),
          expectedContentType: "application/octet-stream",
          allowInsecureLoopback: true,
        }),
      ).rejects.toThrow("integrity check failed");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await expect(readFile(outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not overwrite an identical concurrent download", async () => {
    const payload = Buffer.from("concurrent fixture");
    const digest = createHash("sha256").update(payload).digest("hex");
    const root = await protectedRoot();
    const outputPath = join(root, "fixture.wav");
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Length": payload.length,
        "Content-Type": "audio/wav",
      });
      response.end(payload);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture server address is unavailable");
    try {
      const results = await Promise.all([
        downloadVerifiedArtifact({
          url: `http://127.0.0.1:${address.port}/fixture`,
          outputPath,
          expectedBytes: payload.length,
          expectedSha256: digest,
          expectedContentType: "audio/wav",
          allowInsecureLoopback: true,
        }),
        downloadVerifiedArtifact({
          url: `http://127.0.0.1:${address.port}/fixture`,
          outputPath,
          expectedBytes: payload.length,
          expectedSha256: digest,
          expectedContentType: "audio/wav",
          allowInsecureLoopback: true,
        }),
      ]);
      expect(results.map((value) => value.reused).sort()).toEqual([
        false,
        true,
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(await readFile(outputPath)).toEqual(payload);
    expect(await readdir(root)).toEqual(["fixture.wav"]);
  });

  it("rejects insecure non-loopback URLs and conflicting existing files", async () => {
    const root = await protectedRoot();
    const outputPath = join(root, "artifact.bin");
    await writeFile(outputPath, "conflict", { mode: 0o600 });
    await expect(
      downloadVerifiedArtifact({
        url: "http://example.invalid/artifact",
        outputPath,
        expectedBytes: 1,
        expectedSha256: "a".repeat(64),
        expectedContentType: "application/octet-stream",
      }),
    ).rejects.toThrow("URL is unsafe");
    await expect(
      downloadVerifiedArtifact({
        url: "https://example.invalid/artifact",
        outputPath,
        expectedBytes: 1,
        expectedSha256: "a".repeat(64),
        expectedContentType: "application/octet-stream",
      }),
    ).rejects.toThrow("conflicts with download metadata");
  });
});

async function protectedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-artifacts-"));
  roots.push(root);
  const protectedPath = join(root, "protected");
  await mkdir(protectedPath, { mode: 0o700 });
  await chmod(protectedPath, 0o700);
  return protectedPath;
}

function installationManifest(payloads: {
  release: Buffer;
  model: Buffer;
  fixture: Buffer;
}): InstallationArtifactsResult {
  const artifact = (
    name: keyof typeof payloads,
    filename: string,
    contentType: string,
  ) => ({
    filename,
    bytes: payloads[name].length,
    sha256: createHash("sha256").update(payloads[name]).digest("hex"),
    contentType,
    url: `https://storage.example.invalid/${name}`,
    expiresAt: "2099-09-20T12:00:00.000Z",
  });
  return {
    schemaVersion: 1,
    platform: "darwin-arm64",
    release: {
      version: "0.1.1",
      ...artifact(
        "release",
        "musicmute-worker-darwin-arm64.tar.gz",
        "application/gzip",
      ),
    },
    model: artifact("model", "kim-vocal-2.onnx", "application/octet-stream"),
    fixture: artifact("fixture", "qualification.wav", "audio/wav"),
  };
}
