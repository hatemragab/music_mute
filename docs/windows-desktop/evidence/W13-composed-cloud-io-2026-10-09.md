# W13 composed Cloud I/O source proof

Date: 2026-10-09. Code tests on the development Mac only. No live Firebase/API/R2
request, Windows process, Electron app, browser, codec or GPU execution occurred.

## Actual production composition

[The new fixture](../../../windows-desktop/tests/cloud-composed-io-fixture.ts)
joins the real `AccountController`, `UserRealtimeController` (and shared raw
`AccountRealtimeClient`), `AccountUsageController`, `CloudController`, shared
`CloudProcessingProvider`, `WindowsCloudMedia`/`WindowsCloudMediaRunner`, and
`createWindowsLibrary` with its real controller, disk and immutable artifact
cache. Real `FileCapabilities`, temporary files, streamed transfers, checksum
checks, scratch reservations, write journals and consuming-process pins are used.
There is no parallel fake account/cloud/Library domain controller.

Injected boundaries are synthetic Firebase/backend replies and grants, raw socket
frames, R2 byte streams, POSIX translation of fixed Windows paths, and the existing
native path/process/mutex/codec observation ports. Codec output is bounded synthetic
AAC/MP3-labeled bytes with an injected duration; it proves the orchestration and
byte integrity checks, not actual audio validity. The native operation fixture
runs the real workspace `beforeLaunch`/`onOwner` hooks and strict result parser.
The separate storage/native fixtures define the exact proof boundary for those
injected identities and exit observations. A global fetch guard rejects any
forgotten network destination.

The fixture reproduces the production ready-result subscription's captured
account scope and one-use result-to-Library adoption through trusted metadata.
It does not launch `main.ts`; restricted preload/Main ingress/UI transport proof
is recorded separately in `desktop-ipc-transport.test.tsx`.

## Regression found and corrected

The actual file flow originally retained its prepared-input scratch reservation
until Cloud confirmation's `finally`, then attempted to reserve the same
`cloud/work/<requestId>` for the output before that input closed. Real storage
rejected the duplicate with `STORAGE_SCRATCH_FULL`; separate media/controller tests
had not joined these phases.

[CloudController.resolveDownload](../../../windows-desktop/src/main/cloud/controller.ts)
now closes the prepared media only after the provider has validated genuine Ready
following upload confirmation, then rechecks captured UID/generation and abort
state before clearing that exact media handle and admitting the output workspace.
The selected user source remains unchanged. Failed/uncertain close admits neither
an output byte GET nor a replacement workspace; retained media activity/pins stay
busy. Cancellation during close still reports the existing cancellation-requested
semantics. Final cleanup remains idempotent. The download-grant command may already
have completed before this local close; no HTTP schema or request order changed.

## Seven composed cases

- [x] Signed-in explicit URL confirmation → import raw snapshots → queued/
      processing/Ready job snapshots → owner-authorized grant → counted/hashed
      downloaded bytes → strict probe result → one-use private capability → durable
      immutable Library artifact/catalog. A later Library page snapshot deduplicates
      the same job without a second transfer/adoption.
- [x] The same complete file journey additionally consumes a real read-only source
      capability, copies/prepares private bytes, streams a create-only checksum-bound
      PUT and confirms upload before job Ready. It closes prepared scratch before
      output admission and preserves the original selected file.
- [x] A→logout→B while an object response is pending aborts A's transfer. Ignored
      late response bytes and the captured old socket callback cannot issue a
      capability, run the output probe or attach A's job to B.
- [x] A→logout→B while the actual result descriptor handoff is pending rejects
      late Library adoption, closes the descriptor/workspace, and leaves both
      account catalogs without that job.
- [x] Known-job cancellation while actual prepared pin release is held admits no
      result GET/workspace and finishes only after the close resumes.
- [x] Account change during that same held close rechecks the original authority
      after the await and cannot begin a download under the new account.
- [x] Injected cleanup refusal retains the processing pin/workspace and truthful
      media activity, admits no result GET/replacement, and can finish only after
      that cleanup port supplies a successful retry.

Successful cases assert one intake, one ticket/socket per owner, command-only
backend POSTs, no job/import status GETs, no bearer attached to any R2 request,
exact upload/output bytes and digests, no capability replay, settled journals and
released workspace pins. These assertions are executable in
[cloud-composed-io.test.ts](../../../windows-desktop/tests/cloud-composed-io.test.ts).

## Executed checks

At **22:38:45**, **142 tests / 11 files passed**:

```sh
cd windows-desktop
npx vitest run tests/cloud-composed-io.test.ts tests/account-controller.test.ts tests/realtime-controller.test.ts tests/usage-controller.test.ts tests/cloud-controller.test.ts tests/cloud-transfers.test.ts tests/cloud-media-storage.test.ts tests/cloud-media-runner.test.ts tests/library-controller.test.ts tests/library-artifacts.test.ts tests/desktop-ipc-transport.test.tsx
npm run typecheck
npm run build
npx oxlint --deny-warnings tests/cloud-composed-io.test.ts tests/cloud-composed-io-fixture.ts src/main/cloud/controller.ts
npx prettier --check tests/cloud-composed-io.test.ts tests/cloud-composed-io-fixture.ts src/main/cloud/controller.ts
git diff --check
```

All listed checks passed; lint reported zero warnings/errors. The earlier focused
cloud/controller/media slice passed **33 tests / 3 files** at **22:37:56**. Source
builds do not constitute a runnable Windows installer or native acceptance.

After the coordinating agent extended the restricted bridge test with the six
named P14 actions through a real PlaybackController, this audit also ran
`npx vitest run tests/cloud-composed-io.test.ts tests/desktop-ipc-transport.test.tsx`:
**11 tests / 2 files passed at 22:43:30**. That additional bridge case still uses
injected source/media I/O and does not execute Electron or a Windows decoder.

Dirty-source SHA-256 at this frozen checkpoint:

| File                                 | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `src/main/cloud/controller.ts`       | `2486f9622172fd7f95f4533a71c7586e2e145bee1b79c3f2f4def4e339d87352` |
| `tests/cloud-composed-io.test.ts`    | `8b0943d614b54d9415ceba27f99f9b3f5b8930ae7107bc672de88d0fc13c4de8` |
| `tests/cloud-composed-io-fixture.ts` | `b13c26334f0c133276a0c3695dd7d35229693333cebb00f7d15bb34a2d0f4fa9` |

The [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were reread for this lifecycle return on 2026-10-09. Rules 104 (authorization),
106/107 (compatibility) and 151 (explicit errors) informed retaining current-owner
checks and existing request/cancellation/error semantics. This internal lifecycle
fix changes no REST route, payload, status, OpenAPI or raw socket schema.

## Still deferred

- [ ] Actual Windows AAC/MP3 encoding/probing and whole-tree teardown/ACL/mutex
      behavior, including a held/lost native cleanup acknowledgement.
- [ ] Authorized real Firebase/backend/R2 quota, reconnect, transfer and cancellation
      journeys, actual cold/manual Chrome Cloud and installed UI/device acceptance.

The W13 single composed synthetic I/O deliverable is now covered. Neither that
deliverable nor the portable transport harness closes any W34 native/live row.
