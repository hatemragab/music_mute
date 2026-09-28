// Run in the API container, never on a client. No output includes URLs/keys.
import { ImportFiles } from "file:///app/dist/url-imports/import-files.js";
import { probeImport } from "file:///app/dist/url-imports/import-probe.js";
import { readdir } from "node:fs/promises";

const root = "/tmp/musicmute-acquisition-qualification";
const files = new ImportFiles(root, 0);
const key = process.env.AUDIO_ACQUISITION_API_KEY;
if (!key) throw new Error("Private acquisition credential missing");
const started = performance.now();
await files.withFile(async (path, signal) => {
  const audio = await files.download(
    "http://music-mute-videoscale:8080/audio-imports",
    path,
    50_000_000,
    signal,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        max_bytes: 50_000_000,
        max_duration_seconds: 1200,
      }),
    },
  );
  const probe = await probeImport(path, 1200, signal, "/usr/bin/ffprobe");
  console.log(
    JSON.stringify({
      event: "live-acquisition-qualified",
      bytes: audio.bytes,
      duration_seconds: probe.durationSeconds,
      extension: probe.extension,
      metadata_provider: audio.extraData?.provider ?? null,
      elapsed_ms: Math.round(performance.now() - started),
    }),
  );
});
console.log(
  JSON.stringify({
    event: "qualification-cleanup",
    remaining_files: (await readdir(root)).length,
  }),
);
