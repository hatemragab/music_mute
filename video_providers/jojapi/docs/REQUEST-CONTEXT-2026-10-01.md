# JoJAPI media request context and VPS range probe, 2026-10-01

This historical record describes the request-context qualification while Tunelio
was selected. Its route selection was superseded by the later
[owner-authorized JoJAPI production test activation](ACTIVATION-2026-10-01.md).
The measurements and unresolved source-version evidence below are unchanged.

The user requested matching media headers, cookies, User-Agent and source IP,
plus a small Google range test from the MusicMute VPS. The attached screenshot
was treated as reference material. Its claims about same-IP requirements were
checked against the official API, downloader documentation and a live request.

Production routing remains Tunelio because the separate
[source-version release blocker](DEPLOYMENT-2026-10-01.md) is unresolved. A
successful Google range request does not establish correct requested-source audio.

## Actual network and request context

On 2026-10-01 around 01:36 UTC, one fresh paid `/download` request for the public
YouTube ID `aqz-KE-bpKQ` was made from the deployed private JoJAPI container. The
existing credential stayed in that app's environment; no paid request was retried.
The response was held only in process memory.

| Field                             | Observed value                                                       |
| --------------------------------- | -------------------------------------------------------------------- |
| VPS external egress               | `34.28.228.205`, verified through GCE instance metadata              |
| Signed media URL's `ip` parameter | `92.179.122.208`                                                     |
| IP values match                   | No                                                                   |
| Provider media headers            | `User-Agent`, `Accept`, `Accept-Language`, `Sec-Fetch-Mode`          |
| Provider media cookie supplied    | No                                                                   |
| Forwarded media context           | The four supplied values unchanged, plus `Accept-Encoding: identity` |
| Requested range                   | `bytes=0-1048575`                                                    |

The signed query parameter alone is not proof of universal IP binding. This
request succeeded from a different real egress IP. HTTP headers such as
`X-Forwarded-For` cannot change the TCP connection's network source address;
none were injected. Matching vendor egress would require a documented provider
relay or a common supported proxy, rather than an invented header or a changed
signed query parameter.

## Live curl result

Curl ran on the actual VPS, with the fresh signed URL and supplied headers
passed through stdin rather than process arguments, logs or files. It discarded
media into `/dev/null`. Each relocation was checked before the next request:
HTTPS, exact Google media host/path policy, public DNS answers pinned for TLS,
at most three relocations, a 30-second request bound and a 1 MiB body cap.
This uses explicit validated hops instead of unrestricted `curl -L`.

| Hop                       | HTTP | Downloaded bytes |    Curl duration |    Curl transfer speed |
| ------------------------- | ---: | ---------------: | ---------------: | ---------------------: |
| Initial Google media      |  302 |                0 | 0.309796 seconds |                      0 |
| Validated relocated media |  206 |        1,048,576 | 0.129315 seconds | 8,108,695 bytes/second |

The final partial response had the requested starting range and exact byte
count. Both curl processes exited zero. The measured speed belongs to the
second curl invocation, including its connection setup, not the paid gateway,
whole acquisition or worker processing. No cookie was invented or needed in
this observed response. No signed URL, raw response, cookie or media file was
retained in this record.

## Header and cookie handling

The adapter preserves the supplied User-Agent and three browser headers for
every generated range and validated relocation. Range and identity encoding
remain adapter-controlled to protect exact byte framing and transfer limits.

The user-authorized extension accepts a `Cookie` only from the vendor format
object's `http_headers`, with a 4096-byte ASCII bound, request-cookie syntax,
control/duplicate-header rejection and runtime credential-reflection checks.
It is scoped to the initial exact Google media hostname. It is retained for
same-host ranges/relocations and permanently removed on any cross-host hop.
Caller cookies, gateway/Google `Set-Cookie`, API keys and Authorization are not
forwarded. There is no shared or persistent jar; cookies never enter metadata,
logs or storage. Synthetic cookie tests establish this behavior; the vendor
did not provide cookies in the live probe.

The [official JoJAPI OpenAPI](https://jojapi.com/hub/api/cloud-api-hub-youtube-downloader/openapi.json)
was reread on 2026-10-01. `/download` documents `id`, `filter` and `quality`,
with no cookie export, proxy, egress-IP selection or native relay parameter.
`/mux` documents muxing/conversion and downloadable links; it has not been
qualified as a native relay using the extraction egress. No `/mux` call was made.

The [official yt-dlp FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#i-extracted-a-video-url-but-it-does-not-play-on-another-machine--in-my-web-browser)
explains that some services require matching IP, cookies and/or headers, and
that download options matter. It does not establish that every Google media
link requires the same IP. This repository still contains no extraction runtime.

[RFC 6265 sections 4.2.2 and 5.4](https://www.rfc-editor.org/rfc/rfc6265)
explain that the request Cookie string omits its domain/path attributes and
that host-only cookies match an exact host. That supports conservative initial
host scope rather than assuming every Google CDN host can receive a cookie.

## Validation and deployment

The full JoJAPI suite passed **83 tests in 43.679 seconds** with
`python3.12 -B -m unittest -q test_service.py test_official_metadata.py` from the
adapter directory. Six focused cookie/isolation tests passed separately.
`python3.12 -B -m unittest discover -s video_providers/tests -v` passed all
**13 shared/native integration tests in 9.857 seconds** from the repository root,
including real adapter/router HTTP and the compiled backend media probe.
Formatting, syntax, whitespace, actual vendor-key exclusion and seven-member
archive/source-byte checks passed.

The cookie extension changes only the adapter runtime and its tests. The private
API's routes, bearer contract, binary
framing and sanitized error schema are unchanged. The current
[Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were reread on 2026-10-01: rules 104, 106, 177 and 178 preserve service security,
compatibility, sanitized errors and correct content headers.

The CapRover CLI deployed the seven-member archive to `music-mute-jojapi` at
01:44:57 UTC on 2026-10-01. Its SHA-256 is
`7ef0ff2197793fc11a1412a2106ac9cef5c8601c52a0c0951b95533034ceae4c`.
Image `img-captain-music-mute-jojapi:5` is active and healthy, private, one
replica, port 8080, with no published ports/domains/persistent volumes. Its
runtime source hashes match the current working-tree files, it runs as
`10001:10001`, its root is read-only and all capabilities are dropped.
Private health/unauthorized/malformed-body checks returned **200/401/400**;
scratch contained zero entries. The router remains image 7, with Tunelio selected
for YouTube and VideoScale for other sites. No backend or router redeployment
was needed for this cookie update.

A second fresh link was checked after deployment with the same bounded curl
procedure. The VPS and signed-IP values still differed, all four supplied header
values and User-Agent were preserved, and the provider again supplied no cookie.
It returned **302 → 206**, **1,048,576 bytes**, **0.384608 seconds** and
**2,726,349 bytes/second** for the final curl invocation; both hops exited zero.
These two curl probes measured **2.7–8.1 MB/s** and each consumed one separate
paid gateway request. Failed syntax preparation happened before any gateway
call; no paid acquisition was automatically retried.

Changes remain uncommitted on `main`. No R2 upload, worker job, device test or
MusicMute UI journey was added by this follow-up.

## Evidence limits

This sample proves that one fresh link allowed a complete 1 MiB range from the
actual VPS with the supplied request context and a different signed-IP value.
It does not promise future IP acceptance, every video, sustained load, cookie
availability or a way to reproduce the vendor's network egress. A later 403
still fails without paid replay or automatic provider fallback. It also does
not resolve the independently reproduced wrong-source-version response.
