import { mkdtemp, writeFile, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSessionBackendOrigin,
  validateSessionBackendOrigin,
} from "../src/main/session/backend-origin.js";
const config = {
  backend_base_url: "https://api.example.test/",
  firebase_api_key: "syntheticPublicConfigKey123",
  firebase_project_id: "musicmute-fixture",
};
describe("approved packaged personal community origin", () => {
  it("permits missing account resources for local cache, then uses only validated canonical packaged origin", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "MusicMute origin العربية "),
    );
    try {
      expect(await loadSessionBackendOrigin(directory)).toBeUndefined();
      await writeFile(
        join(directory, "desktop-public-config.json"),
        JSON.stringify(config),
      );
      expect(await loadSessionBackendOrigin(directory)).toBe(
        "https://api.example.test",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    "http://127.0.0.1:9090",
    "https://user:secret@example.test",
    "https://example.test/path",
    "https://example.test?token=secret",
    "https://example.test/",
    "invalid",
  ])("rejects consumer config origin %s", (origin) => {
    expect(() => validateSessionBackendOrigin(origin)).toThrow(
      "SESSION_CONFIG_INVALID",
    );
  });
  it("rejects malformed/duplicate/unknown config and substituted hardlink fixture", async () => {
    const directory = await mkdtemp(
        join(tmpdir(), "MusicMute origin negative "),
      ),
      path = join(directory, "desktop-public-config.json");
    try {
      for (const body of [
        '{"backend_base_url":"https://safe.example","backend_base_url":"https://evil.example"}',
        JSON.stringify({ ...config, token: "never load private tokens" }),
        JSON.stringify({ ...config, firebase_api_key: "x" }),
      ]) {
        await writeFile(path, body);
        await expect(loadSessionBackendOrigin(directory)).rejects.toThrow(
          "SESSION_CONFIG_INVALID",
        );
      }
      await writeFile(path, JSON.stringify(config));
      await link(path, join(directory, "alternate.json"));
      await expect(loadSessionBackendOrigin(directory)).rejects.toThrow(
        "SESSION_CONFIG_INVALID",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
