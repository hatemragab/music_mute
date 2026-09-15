# W03 execution brief

Implement the full [W03 task](../worker/W03-signed-downloads-and-event-spool.md)
after W02 review. Use the current design and contracts as authority; this brief
supplies integration pointers rather than replacing acceptance requirements.

## Ownership and constraints

Own `worker/musicmute_worker/update/`, `worker/musicmute_worker/events.py`, their
focused tests, and a separate minimal launcher dependency lock. Make only the
necessary launcher/configuration integration edits. Other contributors are active:
preserve their work and do not revert changes. Coordinate any shared runtime-file
fingerprint changes with W02. No commits, migration, legacy client adapter,
deployment, production connection, or daemon operation is authorized.

## Existing authorities

- W01 owns protected roots, journal persistence, process containment, launcher
  handshakes, and authenticated installation identity. Reuse those abstractions.
- W02 owns prepared GPU runtime environments and their fingerprint. Updater and
  reporting imports must not depend on a working GPU environment. Its Python
  archive alias normalization is narrowly scoped; do not relax rejection of
  symlinks in signed worker bundles.
- B03 owns wire validation, event identity, redaction, throttling and retention.
  Read `B03-report.md`, `B03-review.md`, backend `worker-event-policy.ts`, event
  DTOs/controllers/service, and response errors before writing the client. Preserve
  installation ownership across setup/permanent authentication transitions.
- B04 owns release publication and target policy. Read its report, actual policy
  responses, publication receipt and signed artifact identities before choosing
  client request/response types. Do not invent a second release authority.

## Required proof

Preflight on 2026-09-14 verified the published TUF 7.0.1 wheel: 56,253 bytes,
SHA-256 `d30434bda6e079ab303fb30d1b3006d939a10ca34783b1573d61cd9b802fa45c`.
Its actual `Updater` constructor requires keyword-only `bootstrap: bytes | None`.
Use embedded trusted root bytes; do not accidentally choose cache-only trust by
passing None. Metadata cache access requires single-instance serialization.
See the [official Updater documentation](https://theupdateframework.readthedocs.io/en/latest/api/tuf.ngclient.updater.html)
and [published release metadata](https://pypi.org/pypi/tuf/7.0.1/json).
TUF requires Python >=3.10, securesystemslib ~=1.0 and urllib3 ~=2.0. The observed
securesystemslib 1.5.1 crypto extra requires cryptography >=48.0.0; explicitly
resolve and hash the crypto backend and transitive wheels for each launcher
platform. TUF alone does not constitute a complete Ed25519 verification runtime.
These are verified inputs, not a completed launcher dependency lock or native proof.

Additional local preflight: `uv pip compile --python-version 3.12 --only-binary
:all: --generate-hashes` resolved `tuf==7.0.1` plus
`securesystemslib[crypto]==1.5.1` for aarch64-apple-darwin,
x86_64-pc-windows-msvc, and x86_64-unknown-linux-gnu. Resulting versions were TUF
7.0.1, securesystemslib 1.5.1, cryptography 50.0.1, cffi 2.1.1, pycparser 3.0,
and urllib3 2.7.0. A temporary Python 3.12.13 macOS environment installed these
with required hashes and binary-only packages, verified a generated Ed25519
signature, and constructed `Updater` with an explicitly supplied signed root.
NumPy, ONNX Runtime, and Torch were absent. No network refresh or production
request occurred. Windows/Linux results are dependency solves, not execution
proof. This does not test update expiry, rotation, downloads, or worker reporting.
Temporary requirements are `/tmp/musicmute-launcher-tuf-{mac,win,linux}-candidate.txt`;
the isolated test environment is `/tmp/musicmute-launcher-tuf-preflight`.
Implementer must replace broad resolver hash lists with exact platform asset
locks and test the real integration rather than treating preflight as acceptance.

Use a maintained TUF client in the launcher environment with pinned dependencies.
Verify its current official API before implementation. Test rollback, expiry,
mix-and-match, corrupt metadata, target length/hash mismatch, key rotation,
untrusted origin/redirects, interruption/resume and extraction confinement.
Untrusted bytes must never execute. Cache references must protect the active,
prepared and allowed rollback assets independently of event TTL.

The durable event spool must preserve exact payloads after acceptance or uncertain
delivery, apply explicit server-time clock correction before first submission,
handle exactly 30-day visibility limits and future-clock rejection, honor
Retry-After and unchanged-progress throttling, retain failure/terminal records
when mixed batches are rejected, and expose losses caused by bounded storage.
Disk-full behavior must preserve the assignment journal. Exercise restart and
network-failure behavior with actual temporary files, not only mocked queues.

Prove the stable launcher can import, fetch policy and report a safe error with
ONNX Runtime deliberately unavailable. Keep this test separate from a simulated
successful GPU qualification. Record exact validation and limitations in
`W03-report.md`; independent review is required before marking the task reviewed.
