/** Reviewed existing versions; these are assembly pins, never download placeholders. */
export const WINDOWS_CONSUMER_PINS = Object.freeze({
  node: "24.18.0",
  python: "3.12.10",
  onnxRuntime: "1.24.4",
  audioSeparator: "0.47.0",
  ffmpeg: "8.0.3",
  deno: "2.9.7",
  provider: "2.0.1",
  downloader: "2026.08.19",
  downloaderBootstrapSha256:
    "2f510f42390050de123e257a8ae85a00266409e02a8142490c3a1b04a9dda6a2",
  providerScriptSha256:
    "718ba412feecbc67d423c30048fb9a5066c195a610773208abfe1912f6f10b7c",
  providerSessionSha256:
    "31834151c54c2cb4550f6c3d2f4c72f2e3d6ff381d3bd7ca2f29922bf8abadb0",
  // Official release checksum metadata checked 2026-10-09; raw archives stay build-side.
  nodeArchiveSha256:
    "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
  denoArchiveSha256:
    "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238",
  canvasArchiveSha256:
    "ba953cc8c38303ab94cc83461c7561506a5a3af37d6c678de4a47914d2d0bb48",
});
export const WINDOWS_CONSUMER_DOWNLOADER_WHEELS = [
  {
    file: "bgutil_ytdlp_pot_provider-2.0.1-py3-none-any.whl",
    version: "2.0.1",
    bytes: 12777,
    sha256: "ff6c2e85443e0777e2483e4a5ef2084ca745a1dd3cc07cf355ddd3a77bd882e8",
  },
  {
    file: "yt_dlp-2026.8.19-py3-none-any.whl",
    version: "2026.08.19",
    bytes: 3_185_533,
    sha256: "1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf",
  },
  {
    file: "yt_dlp_ejs-0.8.0-py3-none-any.whl",
    version: "0.8.0",
    bytes: 53_443,
    sha256: "79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4",
  },
] as const;
