# Public-upload worker security review

Date: 2026-09-24. Scope: targeted source review and local regression tests,
not a penetration test, dependency vulnerability certification or production
configuration audit. The source fixes below have not been installed into the
active local worker release as part of this review.

## Most important boundary

The per-user macOS LaunchAgent runs the supervisor and Python processing child
under the owner's identity. A child process is not an OS sandbox. Not passing
credentials through the environment is helpful, but does not prevent exploited
native code from reading credentials or personal files accessible to that user.
The child also has no OS-enforced network restriction.

Before unrestricted public processing, move the worker to a dedicated machine
without personal files or development/cloud credentials, or implement and qualify
an OS containment boundary. A separate restricted service account reduces file
exposure but does not by itself bound resource use or isolate the kernel.
An Apple App Sandbox integration requires explicit filesystem/GPU/process access
design and real MPS qualification; it must not be represented by a directory name
or an untested launcher flag. Apple describes the intended boundary in
[Protecting user data with App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox).

## Existing defenses verified in source

- Generated UUID attempt directories and fixed local media names; private file
  modes, traversal/symlink checks and attempt cleanup.
- Download byte-count and SHA-256 checks, redirect rejection, TLS by default;
  bounded final MP3 and signed upload headers.
- Media commands use argument arrays with no shell, a local-file protocol and
  demuxer allowlist, allocation/output/sample limits and timeouts.
- One active processing request per child and validated GPU-slot capacity.
- Admission checks for available memory/disk and bounded diagnostic storage.
- Backend admission applies account policy, waiting/processing capacity and
  processing-usage reservations. Effective live quota values were not audited.

## Concrete fixes in this review

1. `worker/engine/musicmute_engine/media.py`: tool stdout/stderr previously
   accumulated through `subprocess.run` before their size was checked. Readers
   now retain at most 64 KiB per stream and kill an overflowing tool immediately.
   Regressions exercise noisy stdout/stderr, normal output and timeout cleanup.
2. `worker/src/agent/child-process.ts`: killing only Python could leave FFmpeg
   running. POSIX processing children now own a process group; forced termination,
   request timeout and exit cleanup kill the group. A real descendant-process
   regression verifies timeout and forced termination on macOS. This is lifecycle
   cleanup, not containment against an attacker deliberately escaping the group.

## Remaining public-release work

| Priority | Gap | Required protection |
| --- | --- | --- |
| High | Same-user native parser/inference execution | Dedicated host or qualified OS isolation; no personal credentials/data |
| High | Admission checks are not hard running-resource quotas | Machine-owned memory/disk watchdog, sustained usage budget, bounded job deadlines and an emergency drain; OS-enforced limits where supported |
| High | Account quotas do not cap all users' aggregate machine use | Verify effective production quotas and global admission ceilings; independent local work budget |
| Medium | Transfer client accepts arbitrary HTTPS grant destinations | Pin approved storage origins, with a deliberate endpoint/redirect policy; do not trust upload-provided URLs |
| Medium | Windows termination stops only the direct child | Windows Job Object with descendant cleanup, independently tested |
| Medium | Pinned native dependencies can still contain vulnerabilities | Audit the actual packaged FFmpeg/Python/native libraries, update and requalify routinely |

Current worker hard ceilings include a 1 GB compressed input and 30 minutes of
decoded audio. Admission checks require 2 GiB available memory and input size
plus roughly 2.3 GiB available disk. These are rejection thresholds, not reserved
resources. Media and transfer timeouts can reach two hours; decoded media limits
and compressed sizes alone do not bound CPU cost. Public jobs can legitimately
keep the machine continuously busy even when each individual job is valid.

## Validation

- Media-limit Python suite: 11 tests, including live noisy subprocesses.
- Child-process Vitest suite: 7 tests, including descendant termination.
- Runtime safety, resource limits, transfers and worker runtime: 31 tests.
- Pipeline Python suite: 10 tests against the existing local runtime.
- Worker TypeScript typecheck, lint and build; `git diff --check`.

No malicious native exploit was executed. No account migration, production
policy mutation, runtime activation, secret rotation or public deployment was
performed. These fixes do not establish that arbitrary public uploads are safe
on the owner's personal account.
