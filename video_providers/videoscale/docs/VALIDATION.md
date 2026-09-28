# Validation ledger — 2026-09-27

## Boundaries

User authorized using their VideoScale credentials and curl to qualify the API
before implementation. One provider task was submitted using a public Blender
sample, format 140. No subscriptions were purchased. All prior unrelated edits
were preserved. Repository changes in this study are documentation only.

## Executed checks

| Location               | Check                                                     | Observed result                               |
| ---------------------- | --------------------------------------------------------- | --------------------------------------------- |
| Mac curl               | Authenticated formats                                     | HTTP 200, 65 formats, 6.753 s                 |
| Mac curl               | Create task with audio format 140, no postprocessors      | HTTP 202 queued, 0.474 s                      |
| Mac curl               | First status sample                                       | HTTP 200, processing despite progress 100     |
| Mac curl               | Later status sample                                       | HTTP 200 completed, relative result endpoint  |
| Mac curl               | Resolve delivery URL                                      | HTTP 200 JSON, HTTP-scheme signed storage URL |
| Mac curl               | Nonexistent task                                          | HTTP 404, `Task not found`                    |
| VPS curl               | API formats without credentials                           | HTTP 401; API TLS/port reachable              |
| VPS curl               | Storage download over HTTPS, without provider credentials | HTTP 200, 10,264,232 bytes, 2.084 s           |
| VPS isolated container | FFprobe inspection                                        | One AAC audio stream, M4A, 634.625 s          |
| VPS isolated container | Full FFmpeg decode to null                                | Exit 0                                        |

The 2.084 s is **storage transfer time only**, not total import latency. No
provider extraction/queue duration or S3/worker end-to-end speed is established.

The two preliminary SSH transfer attempts exited with curl's `no URL specified`
before any storage request: the local safety filter expected HTTPS, while the
provider returned HTTP. The successful attempt explicitly qualified HTTPS on
the same known storage host and used no redirects or TLS bypass.

The VPS was `instance-20260908-184224`, zone `us-central1-a`. FFprobe/FFmpeg were
run in ephemeral, network-disabled media-validation containers,
with a read-only synthetic media mount and no production service modifications.

## Commands / reproduction rules

- Actual HTTP requests used curl with bounded connection/total timeouts, a
  50,000,000-byte cap, HTTPS-only transport and no automatic retries.
- Pass Basic authorization through protected stdin configuration. Do not put
  credentials in shell history, process arguments, `.env` committed files or docs.
- Do not run `curl -v` with live credentials or print signed storage URLs.
- Status/result examples are in [API-FINDINGS.md](API-FINDINGS.md).
- Probe command: `ffprobe -v error -show_entries
format=duration,format_name,size:format_tags=title,artist:stream=codec_type,codec_name,sample_rate,channels,bit_rate
-of json <owned-temporary-audio>`.
- Decode check: `ffmpeg -v error -i <owned-temporary-audio> -f null -`.

## Quota and remaining proof

The dashboard showed 9.85 GB remaining after the study. There was no precise,
isolated before/after measurement; earlier 9.92 GB was from a previous observation.
Do not attribute that entire difference to this task or assert 1:1 bandwidth
billing. One sample does not establish behavior for 5 MB files, other sources,
Arabic metadata, failures, duplicate requests, sustained traffic or outages.

No authenticated control-plane curl test from the VPS was performed. No MusicMute
API import, private S3 upload or separation-worker completion was performed.
No app/device test was performed or needed for this research.

Temporary credentials existed only in process/browser memory. Diagnostic raw
responses and test audio were kept outside the repository in owned temporary
directories for this session. Both local and VPS diagnostic directories were
removed after validation, including raw responses and the synthetic audio.
The credential-handoff listener and curl process were stopped. No user media or
production data was deleted.

## Saved-document checks

- Prettier check passed for the research Markdown and JSON files (now under `video_providers/videoscale/docs/`).
- `jq -e` parsed the example fixture and checked the zero-video-stream result
  and synthetic task ID.
- No application test suite was run: no runtime implementation changed.
