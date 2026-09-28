import { expect, test, vi } from "vitest";
import { supportedAudioUrl, supportedAudioSites } from "./source";
import cases from "./fixtures/url-policy-cases.json";
import catalog from "./data/supported-audio-sites.json";
import { ApiClient } from "../api/client";
import { jobsApi } from "../api/jobs";

test.each(cases)("offline site policy: $url", ({ url, accepted }) => {
  if (accepted) expect(() => supportedAudioUrl(url)).not.toThrow();
  else expect(() => supportedAudioUrl(url)).toThrow();
});

test("enabled platforms retain historical evidence without inventing SaaS proof", () => {
  expect(supportedAudioSites).toHaveLength(12);
  expect(supportedAudioSites).toEqual(
    expect.arrayContaining([
      "YouTube",
      "Instagram",
      "TikTok",
      "Vimeo",
      "SoundCloud",
      "Facebook",
    ]),
  );
  for (const site of catalog.sites) {
    if (!site.evidence) continue;
    expect(site.evidence.vcodec).toBe("none");
    expect(site.evidence.acodec).toBeTruthy();
    expect(site.evidence.acodec).not.toBe("none");
    expect(() => supportedAudioUrl(site.evidence.url)).not.toThrow();
  }
});

test("API boundary rejects unsupported links before token or transport access", () => {
  const token = vi.fn();
  const installationId = vi.fn();
  const api = new ApiClient({
    origin: "https://api.example.com",
    token,
    installationId,
  });
  expect(() =>
    jobsApi(api).createImport(
      "https://unknown.example/audio",
      true,
      crypto.randomUUID(),
    ),
  ).toThrow();
  expect(token).not.toHaveBeenCalled();
  expect(installationId).not.toHaveBeenCalled();
});
