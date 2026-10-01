// Run only in the API container. Each attempt is a separate authorized paid test.
// Inject qualificationKey/qualificationTarget through stdin for a direct-adapter
// test; otherwise use the API's configured private router and ingress key.
import { ImportFiles } from "file:///app/dist/url-imports/import-files.js";
import { probeImport } from "file:///app/dist/url-imports/import-probe.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";

const root = `/tmp/musicmute-jojapi-qualification-${process.pid}`;
const files = new ImportFiles(root, 128_000_000);
const key =
  globalThis.qualificationKey ?? process.env.AUDIO_ACQUISITION_API_KEY;
const target =
  globalThis.qualificationTarget ?? process.env.AUDIO_ACQUISITION_API_URL;
const ids = globalThis.qualificationIds ?? ["jNQXAC9IVRw"];
const parallel = globalThis.qualificationParallel ?? 1;
if (
  !key ||
  !target ||
  !Number.isInteger(parallel) ||
  parallel < 1 ||
  parallel > 4
)
  throw new Error("Private qualification configuration missing or invalid");
if (
  !Array.isArray(ids) ||
  ids.length < 1 ||
  ids.length > 20 ||
  ids.some((id) => !/^[A-Za-z0-9_-]{11}$/.test(id))
)
  throw new Error("Invalid bounded qualification source list");

let next = 0;
async function run() {
  while (next < ids.length) {
    const index = next++;
    const started = performance.now();
    try {
      await files.withFile(async (path, signal) => {
        const audio = await files.download(
          new URL("audio-imports", target).href,
          path,
          100_000_000,
          signal,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              url: `https://www.youtube.com/watch?v=${ids[index]}`,
              max_bytes: 100_000_000,
              max_duration_seconds: 1800,
            }),
          },
        );
        const probe = await probeImport(path, 1800, signal, "/usr/bin/ffprobe");
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path, { signal }))
          hash.update(chunk);
        console.log(
          JSON.stringify({
            event: "live-acquisition-media-validated",
            index,
            requested_video_id: ids[index],
            bytes: audio.bytes,
            duration_seconds: probe.durationSeconds,
            extension: probe.extension,
            metadata_provider: audio.extraData?.provider ?? null,
            sha256: hash.digest("hex"),
            elapsed_ms: Math.round(performance.now() - started),
          }),
        );
      }, AbortSignal.timeout(165_000));
    } catch (error) {
      const response =
        typeof error?.getResponse === "function" ? error.getResponse() : null;
      console.log(
        JSON.stringify({
          event: "live-acquisition-failed",
          index,
          requested_video_id: ids[index],
          code: /^IMPORT_[A-Z_]+$/.test(response?.code ?? "")
            ? response.code
            : "IMPORT_DEPENDENCY_FAILED",
          elapsed_ms: Math.round(performance.now() - started),
        }),
      );
    }
  }
}
await Promise.all(Array.from({ length: Math.min(parallel, ids.length) }, run));
console.log(
  JSON.stringify({
    event: "qualification-cleanup",
    remaining_files: (await readdir(root)).length,
  }),
);
