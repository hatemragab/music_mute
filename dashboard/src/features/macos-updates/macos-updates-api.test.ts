import { describe, expect, it, vi } from "vitest";
import { type ApiClient, OperationOutcomeUnknownError } from "@/api/api-client";
import {
  changeMacosPublication,
  createMacosDraft,
  publicMacosConfiguration,
  reserveMacosUpload,
} from "./macos-updates-api";

const config = {
  revision: 3,
  publicEdKey: "A".repeat(43) + "=",
  feedUrl: "https://api.example.test/macos-updates/appcast.xml",
  downloadBaseUrl: "https://api.example.test/macos-updates/artifacts/",
  configured: true,
  selectedReleaseId: null,
};
const input = {
  appcastBase64: "Zml4dHVyZQ==",
  archiveName: "fixture.dmg",
  bytes: 7,
  sha256Hex: "0".repeat(64),
  operationId: "fixture-operation",
  reason: "Upload release",
};

describe("Mac update commands", () => {
  it("recovers a lost create response without resending or retaining signed URLs", async () => {
    const release = { id: "release", revision: 1 };
    const post = vi.fn().mockRejectedValue(new TypeError("connection lost"));
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: "succeeded", resourceId: "release" })
      .mockResolvedValueOnce(release);
    const result = await createMacosDraft(
      { post, get } as unknown as ApiClient,
      input,
    );
    expect(result).toEqual({ release, grant: null });
    expect(post).toHaveBeenCalledOnce();
    expect(get.mock.calls).toEqual([
      ["/admin/operations/fixture-operation"],
      ["/admin/macos-updates/release"],
    ]);
  });
  it("fences ambiguous pending writes without automatically retrying", async () => {
    const post = vi.fn().mockRejectedValue(new TypeError("connection lost"));
    const get = vi.fn().mockResolvedValue({ status: "pending" });
    await expect(
      createMacosDraft({ post, get } as unknown as ApiClient, input),
    ).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    expect(post).toHaveBeenCalledOnce();
  });
  it("recovers a grant reservation after reload through release read-back", async () => {
    const release = { id: "release", revision: 1 };
    const post = vi.fn().mockRejectedValue(new TypeError("lost grant"));
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: "succeeded", resourceId: "release" })
      .mockResolvedValueOnce(release);
    expect(
      await reserveMacosUpload(
        { post, get } as unknown as ApiClient,
        "release",
        { expectedRevision: 1, operationId: "resume", reason: "Resume" },
      ),
    ).toEqual({ release, grant: null });
    expect(post).toHaveBeenCalledWith("/admin/macos-updates/release/uploads", {
      expectedRevision: 1,
      operationId: "resume",
      reason: "Resume",
    });
  });
  it("reads release and configuration revisions after a lost publication response", async () => {
    const release = { id: "release", state: "published", revision: 2 };
    const post = vi.fn().mockRejectedValue(new TypeError("lost"));
    const get = vi.fn(async (path: string) =>
      path.startsWith("/admin/operations/")
        ? { status: "succeeded", resourceId: "release" }
        : path.endsWith("configuration")
          ? config
          : release,
    );
    const result = await changeMacosPublication(
      { post, get } as unknown as ApiClient,
      "release",
      "publications",
      {
        expectedRevision: 1,
        expectedConfigurationRevision: 3,
        operationId: "publish",
        reason: "Publish",
      },
    );
    expect(result).toEqual({
      release,
      configurationRevision: 3,
      operationId: "publish",
    });
    expect(post).toHaveBeenCalledOnce();
  });
  it("exports exactly the public packaging contract", () => {
    expect(JSON.parse(publicMacosConfiguration(config))).toEqual({
      schema_version: 1,
      feed_url: config.feedUrl,
      download_base_url: config.downloadBaseUrl,
      public_ed_key: config.publicEdKey,
    });
    expect(() =>
      publicMacosConfiguration({ ...config, configured: false }),
    ).toThrow("Configure");
  });
});
