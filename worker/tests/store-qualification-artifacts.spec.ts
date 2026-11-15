import { describe, expect, it, vi } from "vitest";
import {
  WorkerEnrollmentClient,
  STORE_QUALIFICATION_MODEL,
} from "../src/enrollment/enrollment-client.js";
import { toWireCase } from "../src/runtime/wire-case.js";
const id = "bfcd61be-0dd8-47af-889e-5c4aa035fa84",
  credential = "i".repeat(43);
function data() {
  return {
    schemaVersion: 1,
    purpose: "store-qualification-data",
    platform: "windows-amd64",
    installationProfile: "windows-user",
    model: {
      ...STORE_QUALIFICATION_MODEL,
      contentType: "application/octet-stream",
      sourcePolicy: "direct-owner-source-only",
      url: "https://github.com/model/Kim_Vocal_2.onnx",
      allowedHosts: ["github.com"],
      maxRedirects: 2,
    },
    fixture: {
      filename: "qualification.wav",
      bytes: 303,
      sha256: "ab".repeat(32),
      contentType: "audio/wav",
      url: "https://storage.example.invalid/fixture",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}
function client(value: unknown, allowInsecureLoopback = false) {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(toWireCase(value)), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
  );
  return {
    fetcher,
    client: new WorkerEnrollmentClient({
      baseUrl: "https://workers.example.invalid",
      fetch: fetcher as typeof fetch,
      maxAttempts: 1,
      allowInsecureLoopback,
    }),
  };
}
describe("Store qualification data client", () => {
  it("uses its own authenticated empty-body route and returns only the exact pinned model and WAV data", async () => {
    const value = data(),
      f = client(value);
    await expect(
      f.client.storeQualificationArtifacts(id, credential),
    ).resolves.toEqual(value);
    const [url, init] = f.fetcher.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.href).toBe(
      `https://workers.example.invalid/worker/installations/${id}/store-qualification-artifacts`,
    );
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${credential}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    "release",
    "runtime",
    "archiveDigest",
    "signed",
    "storeExecutionQualified",
  ])("rejects an unexpected authority/executable field %s", async (key) => {
    const f = client({
      ...data(),
      [key]: { url: "https://example.invalid/runtime.zip" },
    });
    await expect(
      f.client.storeQualificationArtifacts(id, credential),
    ).rejects.toThrow("unknown field");
  });
  it("rejects unsupported purposes/profiles/platforms and missing model or fixture", async () => {
    for (const delta of [
      { schemaVersion: 2 },
      { purpose: "legacy-release" },
      { platform: "darwin-arm64" },
      { installationProfile: "windows-service" },
      { model: null },
      { fixture: null },
    ]) {
      const f = client({ ...data(), ...delta });
      await expect(
        f.client.storeQualificationArtifacts(id, credential),
      ).rejects.toThrow();
    }
  });
  it("rejects nested runtime grants, altered model pins and unsafe or expired fixture data", async () => {
    const base = data();
    for (const delta of [
      { model: { ...base.model, signature: "pretend" } },
      { model: { ...base.model, sha256: "cd".repeat(32) } },
      { model: { ...base.model, bytes: 1 } },
      { model: { ...base.model, filename: "different.onnx" } },
      { model: { ...base.model, url: "https://unapproved.invalid/model" } },
      { fixture: { ...base.fixture, version: "0.1.3" } },
      { fixture: { ...base.fixture, url: "http://example.invalid/fixture" } },
      { fixture: { ...base.fixture, filename: "runtime.exe" } },
      { fixture: { ...base.fixture, bytes: 43 } },
      { fixture: { ...base.fixture, bytes: 64 * 1024 ** 2 + 1 } },
      { fixture: { ...base.fixture, contentType: "application/zip" } },
      { fixture: { ...base.fixture, expiresAt: "2020-01-01T00:00:00.000Z" } },
    ]) {
      const f = client({ ...base, ...delta });
      await expect(
        f.client.storeQualificationArtifacts(id, credential),
      ).rejects.toThrow();
    }
  });
  it("validates the installation ID and credential before contacting a server", async () => {
    const f = client(data());
    await expect(
      f.client.storeQualificationArtifacts("foreign", credential),
    ).rejects.toThrow();
    await expect(
      f.client.storeQualificationArtifacts(id, "invalid"),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("requires HTTPS data grants even when a loopback enrollment server is explicitly allowed", async () => {
    const value = data();
    for (const delta of [
      {
        fixture: { ...value.fixture, url: "http://127.0.0.1:8080/fixture.wav" },
      },
      {
        model: {
          ...value.model,
          url: "http://127.0.0.1:8080/model.onnx",
          allowedHosts: ["127.0.0.1"],
        },
      },
    ]) {
      const f = client({ ...value, ...delta }, true);
      await expect(
        f.client.storeQualificationArtifacts(id, credential),
      ).rejects.toThrow();
    }
  });
});
