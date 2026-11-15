import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  configurePackagedResourceTrust,
  REQUIRED_PACKAGED_RESOURCES,
  assertPackagedPublisher,
} from "../src/main/browser/package-trust.js";
import { loadConsumerUpdateTrust } from "../src/main/update/metadata.js";
it("updater feed/key/publisher metadata stays bound to the sealed ASAR index after initial configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-updater-trust-"));
  try {
    const resources = join(root, "resources"),
      asar = join(resources, "app.asar"),
      keys = generateKeyPairSync("ed25519"),
      channel = {
        version: 1,
        feed: "https://updates.example.invalid/feed",
        allowedOrigins: ["https://updates.example.invalid"],
        publisherSha256: "9".repeat(64),
        publicKeys: {
          fixture: keys.publicKey
            .export({ type: "spki", format: "pem" })
            .toString(),
        },
      },
      entries = [];
    for (const name of REQUIRED_PACKAGED_RESOURCES) {
      const [placement, ...rest] = name.split(":"),
        path = rest.join(":"),
        bytes = Buffer.from(
          path === "update-channel.json"
            ? JSON.stringify(channel)
            : "synthetic fixed resource",
        );
      const absolute = join(
        placement === "app" ? root : resources,
        ...path.split("/"),
      );
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
      entries.push({
        placement,
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    await mkdir(asar, { recursive: true });
    await writeFile(
      join(asar, "packaged-resources.json"),
      JSON.stringify({
        version: 1,
        appId: "com.musicmute.local.windows",
        appVersion: "1.0.0",
        payloadSha256: "a".repeat(64),
        publisherSha256: "9".repeat(64),
        entries,
      }),
    );
    await configurePackagedResourceTrust(resources, asar);
    expect((await loadConsumerUpdateTrust(resources)).feed).toBe(channel.feed);
    expect(() => assertPackagedPublisher("8".repeat(64))).toThrow(
      "PACKAGED_TRUST_INVALID",
    );
    await writeFile(
      join(resources, "update-channel.json"),
      JSON.stringify({
        ...channel,
        feed: "https://updates.example.invalid/changed",
      }),
    );
    await expect(loadConsumerUpdateTrust(resources)).rejects.toThrow(
      "PACKAGED_TRUST_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
