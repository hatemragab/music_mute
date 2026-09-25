> Retired Cobalt design/evidence. Do not use these deployment instructions. The active replacement is [yt-dlp](../ytdlp_test/README.md), tracked in its [migration plan](../ytdlp_test/migration-plan.md).

# YouTube / Cobalt diagnostic audit

Checked 2026-09-25, approximately 19:00–19:06 UTC. Investigation only: no
production configuration, image, source, or enabled-provider changes.

## Conclusion

The evidence does **not** establish a blanket Google Cloud IP block. Googlevideo
accepts some small audio range requests from this VPS but rejects other requests.
Cobalt's current official implementation also conceals upstream errors behind
an empty HTTP 200 response. A complete YouTube download remains unverified and
YouTube remains disabled. NestJS/S3 are downstream of the failing transfer.

## Verified deployment

- Cobalt 11.7.1; Node v24.14.1; youtubei.js 17.0.1.
- Current official `ghcr.io/imputnet/cobalt:11` Linux amd64 digest matches the
  running image: `sha256:df14a3b3fe4390d4e1c2d4761ed58981d34aa5fc82d0df2091bab890e7dfaa8b`.
- Running YouTube extractor, helper, stream handler, and stream header source
  hashes match official revision `a636575b09de1fc55d9b8cd98cac88f5f2f16b42`.
- Private API, service-key authentication, forced local processing, duration cap
  1,200 seconds. No custom client, cookies, proxy, or IP routing configuration.
- Optional session helper stopped; stale session-server variable already removed.
  Earlier ENOTFOUND logs are a separate resolved stale-dependency problem.
- Normal native-audio extraction uses IOS, not the optional web session helper.

Re-pulling the same official tag would supply the same image, not a fix.

## Live request evidence

Used official unchanged extractor for Blender Big Buck Bunny (`aqz-KE-bpKQ`),
native M4A, audio-only, non-HLS. Signed URLs were freshly generated, advertised
approximately six hours remaining, and contained the VPS source IP. Tests used
Cobalt's own service headers from inside its container. No video was requested.
Signed URLs and tokens are deliberately omitted.

| Probe | Result |
| --- | --- |
| Fresh URL A: HEAD | 403, zero bytes |
| Same URL A: GET `bytes=0-65535` | 206, 65,536 bytes, `audio/mp4` |
| Fresh URL B: full GET | 403, zero bytes |
| Fresh URL C: GET covering entire advertised file | 403, zero bytes |
| Fresh URL D: GET `bytes=0-65535` | 206, 65,536 bytes |
| Same URL D: GET `bytes=65536-131071` | 206, 65,536 bytes |
| Same URL D: GET `bytes=0-8000000` (Cobalt's first chunk) | 403, zero bytes |
| Unchanged official stream function with isolated synthetic upstream 403 | Ends response without setting error status; default 200 remains |

URL D advertised 10,271,496 bytes. Successful ranges returned matching
Content-Range offsets and total size. This demonstrates partial media delivery,
not a completely downloaded or decoded valid audio file. Full probes returned
no media; ffprobe was unavailable inside Cobalt, and no successful media probe
or complete decode is claimed. Diagnostic bytes were held in process memory;
no downloaded media file was retained and no S3/job was created.

## Confirmed official code issues

The [chunked stream handler](https://github.com/imputnet/cobalt/blob/a636575b09de1fc55d9b8cd98cac88f5f2f16b42/api/src/stream/internal.js)
uses HEAD to discover length before downloading YouTube data. An unsuccessful
HEAD ends the response without propagating the upstream status. This explains
the observed empty-200 symptom. It then uses approximately 8 MB GET ranges;
that actual range also failed in the live matrix, so skipping HEAD alone is
not a demonstrated solution.

The optional helper has a separate protocol mismatch: Cobalt requests
`POST /get_pot`, while the official generator documents/exposes `/token`.
The [Cobalt change](https://github.com/imputnet/cobalt/commit/d8ca5855a9598700e4b184677264e64c577601fe)
changed both method and endpoint. Previous live checks of the deployed helper
returned 404 for `/get_pot` and 503 for `/token`. Correcting DNS does not correct
these failures, and the normal IOS audio path does not use this helper anyway.

## Token hypothesis and its limits

The default IOS request returned a signed native URL without a `pot` parameter.
The [maintainer PO-token guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
documents IOS media/player token requirements and explains that web tokens
cannot simply be reused as IOS tokens. This makes client/token compatibility a
credible contributor; it is **not** proof of why these particular requests were
rejected. The successful small ranges also prevent claiming that the absence
of a token always blocks all data. No alternate extractor was installed or run.

Related [Cobalt issue 1455](https://github.com/imputnet/cobalt/issues/1455) contains
reports of the same empty-tunnel symptom and helper endpoint errors. Those are
corroborating reports, not a verified fix for this deployment.

## Meaning of the browser screenshot and next steps

The screenshot proves a Googlevideo 403, not its reason. The signed URL contains
the VPS IP; opening it from another network is not a controlled comparison and
does not rule IP/session restrictions in or out. A raw browser request also
differs from Cobalt's headers and byte-range requests.

The next candidate must address both failed initial probing and rejected media
requests, then prove one entire native audio transfer and the existing S3/job
flow. There is no verified configuration-only fix from this audit. Keep the
official-image/no-fork/no-adapter/no-custom-client constraints; do not deploy an
unreviewed patch, rotate IPs, or enable YouTube based on metadata or partial
bytes. SoundCloud/Tumblr remain the enabled providers.

Official deployment references:
[setup](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md),
[environment](https://github.com/imputnet/cobalt/blob/main/docs/api-env-variables.md),
[generator](https://github.com/imputnet/yt-session-generator).

## Follow-up: complete small-range attempt

After the owner requested a working YouTube solution, attempted one complete
native audio transfer with strict 64 KiB ranges, using the unchanged official
extractor and service headers. Expected total: 10,271,496 bytes. Each response
had to be 206 with the exact expected Content-Range and byte count. No retries.

The first 16 requests delivered 1,048,576 bytes; request 17 failed with 403 at
offset 1,048,576. The attempt stopped immediately. No full file, S3 object, or
job was produced; in-memory partial data was discarded on process exit.
This rules out simply reducing the chunk size as a sufficient solution for
this sample. It does not identify the upstream reason or a universal limit.

Reviewed upstream [PR 1581](https://github.com/imputnet/cobalt/pull/1581), still
open: its author reports a 1 MiB test, not a complete download. That evidence is
insufficient for our acceptance gate. No patch from this PR was applied.

### Proposed alternative, awaiting owner's scope decision

Test official yt-dlp for YouTube only in an isolated environment on the VPS.
Use explicit native audio-only selection (`bestaudio[vcodec=none]`), never a
combined-media fallback, no audio extraction/conversion, and no playlists.
Pin verified dependencies and any required JavaScript runtime/challenge support.
If attestation is needed, assess the documented maintained token-provider path;
do not import personal browser cookies or introduce network/proxy changes.

First prove a full permitted test item beyond 1 MiB, inspect all tracks and
duration, and verify cleanup. Only after that proof, integrate the YouTube
acquisition branch into `ImportProcessor` inside the existing `ImportFiles`
temporary-file lifecycle, enforcing byte/duration/time/concurrency limits and
safe process cancellation. Preserve current validation, immutable S3 handoff,
quota accounting, worker dispatch, and Cobalt handling for other providers.
Then run focused fault tests and a separate-account full public-API job before
enabling YouTube. A different extractor is not a guarantee against upstream
restrictions; stop and report if the controlled full-transfer test fails.

This proposal changes the original explicit no-yt-dlp requirement. No alternate
extractor was installed or executed, and no production mutation was performed.
