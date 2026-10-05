import { expect, test, vi } from "vitest";
import { supportedAudioUrl, supportedAudioSites } from "./source";
import cases from "./fixtures/url-policy-cases.json";
import catalog from "./data/supported-audio-sites.json";
import { ApiClient } from "../api/client";
import { jobsApi } from "../api/jobs";

test.each(cases)(
  "offline site policy: $url",
  ({ url, accepted, canonicalUrl }) => {
    if (accepted) {
      const result = supportedAudioUrl(url);
      if (canonicalUrl) expect(result).toBe(canonicalUrl);
    } else expect(() => supportedAudioUrl(url)).toThrow();
  },
);

test("API submits only the selected YouTube video from a playlist share", async () => {
  const post = vi
    .fn()
    .mockResolvedValue({ importId: "import", status: "queued" });
  const api = { post } as unknown as ApiClient;
  await jobsApi(api).createImport(
    "https://www.youtube.com/watch?v=e6WT8RwRwt4&list=RDe6WT8RwRwt4&start_radio=1",
    true,
    "request-id",
  );
  expect(post).toHaveBeenCalledExactlyOnceWith("/media-imports", {
    url: "https://www.youtube.com/watch?v=e6WT8RwRwt4",
    trimEnabled: true,
    requestId: "request-id",
  });
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
