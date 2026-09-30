# VideoScale documentation

> **Storage update — 2026-09-30:** AWS/S3 observations and setup commands below
> belong to earlier releases. They are historical evidence, not R2 acceptance.
> Do not execute the old provider/versioning/tiering/acceleration setup. Use the
> [current private R2 Standard setup and verification guide](../../../docs/r2-storage/README.md); the owner
> approved fresh MongoDB and quoted ETag identities with no legacy bridge.

Start with [shared provider architecture](../../README.md) and
[VideoScale implementation/setup](../README.md). The adapter is implemented;
research observations below are dated evidence, not an unimplemented proposal.

- [AI handoff](AI-HANDOFF.md): current architecture, owner decisions and boundaries.
- [Private OpenAPI](../openapi.yaml): uniform request, binary response, metadata
  and error contract.
- [API findings](API-FINDINGS.md): observed vendor operations, fields and gaps.
- [Qualification ledger](VALIDATION.md): preliminary API and VPS transfer checks.
- [Deployment evidence](DEPLOYMENT.md): release identity and complete live import,
  S3, metadata, worker and cleanup proof from 2026-09-27.
- [Backend release 82](RELEASE-82.md): cleanup deployment and fresh real import,
  exact S3 integrity checks and playback proof from 2026-09-28.
- [Local cleanup](LOCAL-CLEANUP.md): subsequent local-only changes and checks.
- [Sanitized examples](examples/observed-responses.json): selected real fields
  with synthetic task IDs and delivery URLs.

## Data handling

Never save API usernames/passwords, Basic Auth strings, cookies, real environment
files, signed URLs, raw provider responses or downloaded user media here.
Credentials belong in protected runtime settings, not source or archives.
Examples are incomplete fixtures, not a guarantee of vendor schema stability.

## Vendor references

- [Signed-in API docs](https://videoscale.sh/dashboard/docs)
- [Public API overview](https://videoscale.sh/api-docs)
- [Terms](https://videoscale.sh/terms)
- [Pricing](https://videoscale.sh/#pricing)

These were consulted during the dated qualification. Recheck them before making
pricing, usage-rights or capacity decisions. A successful sample does not
establish an uptime SLA, unlimited use or immunity to source blocking.
