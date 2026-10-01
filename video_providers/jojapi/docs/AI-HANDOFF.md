# JoJAPI implementation handoff

The owner explicitly authorized production YouTube test activation through the
private JoJAPI adapter on 2026-10-01 despite the reproduced vendor source-version
mismatch. The configured route now selects JoJAPI; read the
[activation record](ACTIVATION-2026-10-01.md) for current deployment evidence and
the [initial qualification record](DEPLOYMENT-2026-10-01.md) for the defect.
Separate sequential requests for two different public IDs returned identical
audio hashes; cache bypass headers did not fix it. The native format object
has no source identity, and ffprobe or requested-URL oEmbed cannot establish
which video the bytes belong to. Require a provider fix and fresh source
correlation before claiming correct-source acquisition. The explicit test
activation does not establish that the defect is fixed. Configuration examples
may retain Tunelio; route changes are deliberate operator choices, never automatic
per-request fallback.

Read [adapter README](../README.md), [private OpenAPI](../openapi.yaml),
[provider architecture](../../README.md) and [provider instructions](../../AGENTS.md).

Source owns a contract-compatible YouTube-only adapter, not a backend vendor branch.
Exactly one JoJAPI `/download` call requests `audioonly` / `highestaudio`; only
eligible native WebM Opus or M4A AAC is accepted. HTTPS Google delivery is
host/path allowlisted with public DNS pinning and TLS verification. Only the
four bounded non-secret vendor browser headers may be forwarded unchanged. An
optional vendor `http_headers.Cookie` has bounded request-cookie syntax and exact
initial Google host scope. Preserve it only for that host's relocations/ranges;
permanently strip it on cross-host relocation. Never import caller cookies,
`Set-Cookie`, a shared jar, or forward API/internal credentials. Cookie values
never enter metadata, logs or storage. No gateway redirects, provider replay, paid metadata, FFmpeg or extraction
fallback. Google media may relocate at most three times; each absolute Location
must pass the same host/path/HTTPS/public DNS/TLS policy. Loops, missing/duplicate
Location headers and excess hops fail within the original deadline. Initial and
relocated URLs reject exact vendor/internal credentials both raw and
percent-decoded; legitimate signed-media query parameters remain accepted.

Do not spoof source IP using HTTP headers: Google sees actual VPS network egress.
The [request-context probe](REQUEST-CONTEXT-2026-10-01.md) succeeded with a signed
IP parameter different from the VPS IP, preserving the supplied browser headers
and with no supplied cookies. This is sampled evidence, not an IP-binding or
future-blocking guarantee. Matching vendor egress would need a documented relay
or shared supported proxy; `/mux` is not qualified as that relay.

Live 2026-10-01 gateway JSON can be labelled `text/html; charset=utf-8`.
Accept only application/json or text/html for the bounded paid response, then
strictly decode JSON and validate the native format. HTML/challenges, unknown
MIME and malformed payloads remain terminal, with no media request or replay.
The private API and Google audio MIME policies are unaffected.

Native media with exact provider filesize uses generated 10 MiB HTTP ranges,
at most ten spans under the hard byte cap. Every 206 requires a singular exact
Content-Range and complete bounded span bytes. A first ignored range may consume
one complete 200 body; a later 200 or ambiguous partial/full response fails.
Unknown-size media retains one full GET. No failed span is retried. All spans
reuse the last validated CDN URL and share the original deadline/redirect budget.

JoJAPI's published one-request-per-second allowance is stricter than the shared
router's five starts: the provider Admission class clamps to one and enforces a conservative 1.1-second
minimum start interval while retaining the shared cooldown and cancellation guards. Capacity is
twenty; dedicated tmpfs scratch, anonymous files and original deadlines use the
qualified existing provider patterns. One process/replica per service is required.

Vendor credentials belong only in this app's environment. Internal service key
comes from `/captain/data/musicmute-acquisition/jojapi-api-key`; no real values
belong in source, archives, logs, docs or fixtures. Optional oEmbed is nonfatal,
unpaid and sanitizes `jk_` markers as well as existing URL/secret markers.

Local fixture tests and image packaging do not prove deployment, live Google
blocking, sustained availability, billing or R2/worker processing. Live evidence
must name its exact date/time, sources, egress and limitations without storing
signed links, raw provider payloads or real user media. A successful short probe
cannot guarantee that Google will not block the IP later.
