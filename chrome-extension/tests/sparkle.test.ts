import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const moduleURL = new URL("../scripts/sparkle-artifacts.mjs", import.meta.url)
  .href;
const {
  validateUpdaterConfiguration,
  parseDashboardUpdaterConfiguration,
  packagingUpdaterConfiguration,
  SPARKLE,
} = (await import(moduleURL)) as {
  validateUpdaterConfiguration(value: {
    feedURL?: string;
    publicKey?: string;
    version: string;
    build: string;
  }): { configured: boolean; version: string; build: string };
  SPARKLE: { version: string; url: string; sha256: string };
  parseDashboardUpdaterConfiguration(value: unknown): {
    feedURL: string;
    publicKey: string;
    downloadBase: string;
  };
  packagingUpdaterConfiguration(value: {
    version: string;
    build: string;
    configFile?: string;
    feedURL?: string;
    publicKey?: string;
  }): Promise<{ configured: boolean; feedURL?: string; publicKey?: string }>;
};
const key = Buffer.alloc(32, 7).toString("base64");
const base = { version: "0.2.0", build: "2" };
describe("macOS update configuration", () => {
  it("leaves development builds explicitly unconfigured", () => {
    expect(validateUpdaterConfiguration(base)).toEqual({
      ...base,
      configured: false,
    });
    expect(SPARKLE.version).toBe("2.10.0");
    expect(SPARKLE.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("requires a paired HTTPS feed and canonical Ed25519 public key", () => {
    expect(
      validateUpdaterConfiguration({
        ...base,
        feedURL: "https://updates.example.com/mac/appcast.xml",
        publicKey: key,
      }).configured,
    ).toBe(true);
    expect(() =>
      validateUpdaterConfiguration({ ...base, publicKey: key }),
    ).toThrow("UPDATER_CONFIG_INCOMPLETE");
  });
  it.each([
    "http://example.com/feed",
    "https://localhost/feed",
    "https://127.0.0.1/feed",
    "https://[::1]/feed",
    "https://username:password@example.com/feed",
    "https://example.com/feed?secret=x",
    "https://example.com/feed#fragment",
    "https://example.com:8443/feed",
  ])("rejects unsafe or credential-bearing feed %s", (feedURL) => {
    expect(() =>
      validateUpdaterConfiguration({ ...base, feedURL, publicKey: key }),
    ).toThrow("UPDATER_FEED_INVALID");
  });
  it.each(["", "key", Buffer.alloc(31).toString("base64"), `${key}\n`])(
    "rejects invalid public key",
    (publicKey) => {
      expect(() =>
        validateUpdaterConfiguration({
          ...base,
          feedURL: "https://example.com/feed",
          publicKey,
        }),
      ).toThrow();
    },
  );
  it.each([
    { version: "1.2", build: "2" },
    { version: "1.2.3", build: "0" },
    { version: "1.2.3", build: "2.1" },
  ])("rejects ambiguous Sparkle versions", (value) => {
    expect(() => validateUpdaterConfiguration(value)).toThrow(
      "MACOS_VERSION_INVALID",
    );
  });
});

const dashboardConfig = {
  schema_version: 1,
  feed_url: "https://api.music-mute.com/macos-updates/appcast.xml",
  download_base_url: "https://api.music-mute.com/macos-updates/artifacts/",
  public_ed_key: key,
};
describe("dashboard publisher configuration", () => {
  it("uses the downloaded public settings for sealed package configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "musicmute-publisher-"));
    try {
      const configFile = join(directory, "public.json");
      await writeFile(configFile, JSON.stringify(dashboardConfig));
      expect(
        await packagingUpdaterConfiguration({ ...base, configFile }),
      ).toMatchObject({
        configured: true,
        feedURL: dashboardConfig.feed_url,
        publicKey: key,
      });
      await expect(
        packagingUpdaterConfiguration({ ...base, configFile, publicKey: key }),
      ).rejects.toThrow("UPDATER_CONFIG_CONFLICT");
      await writeFile(configFile, "invalid json");
      await expect(
        packagingUpdaterConfiguration({ ...base, configFile }),
      ).rejects.toThrow("UPDATER_DASHBOARD_CONFIG_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects cross-origin archives, altered feed paths, missing settings and secret fields", () => {
    for (const value of [
      {
        ...dashboardConfig,
        download_base_url: "https://other.example.com/macos-updates/artifacts/",
      },
      {
        ...dashboardConfig,
        feed_url: "https://api.music-mute.com/arbitrary.xml",
      },
      { ...dashboardConfig, public_ed_key: null },
      { ...dashboardConfig, private_key: "must-not-be-imported" },
    ])
      expect(() => parseDashboardUpdaterConfiguration(value)).toThrow();
  });
});

const releaseModuleURL = new URL(
  "../scripts/prepare-macos-update.mjs",
  import.meta.url,
).href;
const { parseUpdateOptions, updateAppcast, validateAcceptedUpdateRecord } =
  (await import(releaseModuleURL)) as {
    parseUpdateOptions(args: string[]): {
      releaseResult: string;
      downloadBase?: string;
      dashboardConfig?: string;
      account: string;
    };
    updateAppcast(value: {
      version: string;
      build: string;
      archiveURL: string;
      signature: string;
      bytes: number;
    }): string;
    validateAcceptedUpdateRecord(
      release: Record<string, unknown>,
      receipt: Record<string, unknown>,
      directory: string,
    ): void;
  };
describe("local signed update asset preparation", () => {
  it("accepts dashboard config instead of an independently entered download base", () => {
    expect(
      parseUpdateOptions([
        "--release-result",
        "/fixture/release-result.json",
        "--dashboard-config",
        "/fixture/public.json",
        "--keychain-account",
        "MusicMute-Updates",
      ]),
    ).toEqual({
      releaseResult: "/fixture/release-result.json",
      dashboardConfig: "/fixture/public.json",
      account: "MusicMute-Updates",
    });
    expect(() =>
      parseUpdateOptions([
        "--release-result",
        "/fixture/release-result.json",
        "--dashboard-config",
        "/fixture/public.json",
        "--download-base",
        "https://example.com/",
        "--keychain-account",
        "MusicMute-Updates",
      ]),
    ).toThrow("INVALID_UPDATE_OPTIONS");
  });
  it("accepts the notarization workflow's immutable accepted DMG location", () => {
    const directory = "/fixture/release.noindex";
    const release = {
      state: "READY",
      notarized: true,
      stapled: true,
      public_ready: true,
      dmg_gatekeeper_accepted: true,
      contained_app_gatekeeper_accepted: true,
      release_root: directory,
      sha256: "a".repeat(64),
      dmg: join(directory, "accepted.noindex", "MusicMute-0.2.0-arm64.dmg"),
      version: "0.2.0",
      build: "2",
      submission_id: "same-submission",
    };
    const receipt = {
      state: "READY",
      public_ready: true,
      stapled_sha256: release.sha256,
      submission_id: release.submission_id,
      version: release.version,
      build: release.build,
    };
    expect(() =>
      validateAcceptedUpdateRecord(release, receipt, directory),
    ).not.toThrow();
    for (const change of [
      { dmg: join(directory, "MusicMute-0.2.0-arm64.dmg") },
      { dmg: "/other/accepted.dmg" },
      { notarized: false },
      { sha256: "b".repeat(64) },
    ])
      expect(() =>
        validateAcceptedUpdateRecord(
          { ...release, ...change },
          receipt,
          directory,
        ),
      ).toThrow("ACCEPTED_UPDATE_RELEASE_REQUIRED");
  });
  it("accepts only a release record, HTTPS archive base and keychain account name", () => {
    expect(
      parseUpdateOptions([
        "--release-result",
        "/fixture/release-result.json",
        "--download-base",
        "https://updates.example.com/mac/",
        "--keychain-account",
        "MusicMute-Updates",
      ]),
    ).toEqual({
      releaseResult: "/fixture/release-result.json",
      downloadBase: "https://updates.example.com/mac/",
      account: "MusicMute-Updates",
    });
    expect(() => parseUpdateOptions(["--password", "secret"])).toThrow(
      "INVALID_UPDATE_OPTIONS",
    );
    expect(() =>
      parseUpdateOptions([
        "--release-result",
        "/fixture/release-result.json",
        "--download-base",
        "https://updates.example.com/mac/",
        "--keychain-account",
        "space password",
      ]),
    ).toThrow("UPDATE_KEYCHAIN_ACCOUNT_INVALID");
  });
  it("generates a versioned immutable archive entry with a canonical signature and ARM64 system floor", () => {
    const xml = updateAppcast({
      version: "0.2.0",
      build: "2",
      archiveURL: `https://updates.example.com/MusicMute-0.2.0-2-arm64-${"a".repeat(64)}.dmg`,
      signature: Buffer.alloc(64, 9).toString("base64"),
      bytes: 42,
    });
    expect(xml).toContain("<sparkle:version>2</sparkle:version>");
    expect(xml).toContain(
      "<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>",
    );
    expect(xml).toContain('length="42"');
    expect(xml).toContain('sparkle:edSignature="');
  });
  it("refuses malformed signatures, versions and untrusted HTTP archives", () => {
    const item = {
      version: "0.2.0",
      build: "2",
      archiveURL: "https://updates.example.com/app.dmg",
      signature: Buffer.alloc(64, 9).toString("base64"),
      bytes: 42,
    };
    expect(() => updateAppcast({ ...item, signature: "unsigned" })).toThrow(
      "UPDATE_ENTRY_INVALID",
    );
    expect(() =>
      updateAppcast({ ...item, archiveURL: "http://example.com/app.dmg" }),
    ).toThrow("UPDATER_FEED_INVALID");
    expect(() => updateAppcast({ ...item, bytes: -1 })).toThrow(
      "UPDATE_ENTRY_INVALID",
    );
  });
});
