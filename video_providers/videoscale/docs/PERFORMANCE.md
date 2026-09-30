# Acquisition performance investigation — 2026-09-30

The URL import's `source-download` timer measures the entire private adapter
request. It includes format discovery, task creation, waiting for VideoScale,
delivery resolution, provider-to-adapter audio transfer and adapter-to-NestJS
transfer. It is not a measurement of audio bandwidth alone. Validation, S3 input
upload and confirmation have separate server timers. `POST /media-imports`
returns 202 after admission; BullMQ starts acquisition asynchronously.

## Current production measurements

Read-only inspection on 2026-09-30 confirmed API image 95 and adapter image 7,
each with one running replica. The previous 48 hours contained seven complete
successful adapter operations: 11.250–41.871 seconds, median 21.679 seconds.
This small sample is diagnostic evidence, not an availability or latency SLA.

An existing 20.800-second YouTube operation was split using its correlated
adapter step timestamps:

| Operation                                                       | Duration |
| --------------------------------------------------------------- | -------: |
| Format discovery                                                |  7.052 s |
| Task creation                                                   |  0.709 s |
| Task completion checks, including provider work and local waits | 10.600 s |
| Delivery URL resolution                                         |  0.552 s |
| Provider audio transfer, 3,690,149 bytes                        |  1.716 s |

It used five status reads, including three unrecognized string states before
`processing` and `completed`. These logs cannot reveal the vendor's internal
queue/extraction breakdown. Poll waits overlap provider execution; their sum
cannot be subtracted from the total as a guaranteed improvement.

## One fresh authenticated API journey

The signed-in production web app submitted the existing public Blender
[Big Buck Bunny sample](https://www.youtube.com/watch?v=aqz-KE-bpKQ) once.
No second paid diagnostic submission or automatic task retry was made.
The page reached Ready through the existing realtime updates.

| Backend measurement             |  Duration |
| ------------------------------- | --------: |
| Import queue                    |    450 ms |
| Acquisition (`source-download`) | 40,023 ms |
| Independent validation          |  1,028 ms |
| S3 input upload                 |    458 ms |
| Upload confirmation             |  1,468 ms |

The correlated adapter operation took 39,979 ms. Its phase spans were format
discovery 6,065 ms, task creation 645 ms, completion checks 28,417 ms, delivery
resolution 515 ms and audio transfer 3,980 ms. There were twelve status reads,
including nine unrecognized states. This run demonstrates that upstream
preparation can exceed the reported twenty seconds.

The input was independently measured as 10,202,210 bytes and 634.601 seconds,
WebM/Opus, 48 kHz, stereo. MongoDB recorded a confirmed input with no error;
read-only HEAD verified the exact input and output S3 versions' bytes, SHA-256
and content types. The vocal output was 1,491,113 bytes; both MongoDB and the
browser showed Ready with no error. Backend scratch contained zero entries
after acquisition. The test media remains under normal account retention.
Provider cache reuse is unknown, so this
must not be described as an uncached source benchmark.

## Verified transport opportunity

The deployed adapter opened a fresh DNS/TCP/TLS connection for every vendor API
request. A bounded read-only probe from its VPS queried the documented status
route using a synthetic nonexistent task ID. It created no download task, read
each response completely and printed only timing/status fields.

| Probe                          | Connection setup | Request after connection |  Total |
| ------------------------------ | ---------------: | -----------------------: | -----: |
| Fresh connection 1             |           442 ms |                   225 ms | 667 ms |
| Fresh connection 2             |           288 ms |                   224 ms | 511 ms |
| Fresh connection 3             |           283 ms |                   224 ms | 507 ms |
| Reuse series, first connection |           290 ms |                   231 ms | 520 ms |
| Reused connection 1            |             0 ms |                   129 ms | 129 ms |
| Reused connection 2            |             0 ms |                   118 ms | 118 ms |

All responses were 404 and permitted HTTP keepalive. These numbers qualify
connection reuse at the transport level; they do not prove an optimized import
duration. Error responses remain discarded by the production client. Successful
read reuse is covered by a local HTTP/1.1 fixture, with transport failure,
server-close, cancellation and paid-POST isolation regressions.

## Local optimization and limits

The adapter retains one fully consumed, successful vendor GET connection within
an acquisition. It discards failed/partial/malformed/closed connections, closes
it at the end of control requests and always cleans up on cancellation/failure.
The paid POST uses a fresh connection and is never automatically repeated.
Storage transfer uses a separate connection without vendor authentication.
No connection is shared between imports, and public DNS/TLS verification remains
in force for each new connection.

Sanitized request timings identify method, phase, elapsed request time and
whether an existing connection was selected. They omit URLs, task IDs, bodies
and credentials. Normal two-second status polling, explicit completion gating,
audio selection, validation and private response contracts remain unchanged.
Fresh-task 404 recovery uses one progressive 1/2/3/4-second backoff per retry,
within the existing four-read budget, instead of adding both a retry pause and
a synthetic pending-state pause. The ten-second propagation window is preserved.

The local HTTP integration also exercises POST admission/replay, real BullMQ,
Mongo transactions, native adapter transfer, ffprobe, byte/checksum preservation,
persisted timing presentation and cleanup. Identity, account eligibility,
provider and storage/job services are synthetic fixtures; this is distinct from
the authenticated production journey above.

These changes are not deployed. Reuse reduces request overhead, especially when
many status reads are needed. It cannot remove VideoScale's format extraction
or task preparation time, and faster GETs also overlap ongoing vendor work.
There is no supported shortcut in the current
[official API documentation](https://videoscale.sh/api-docs) that safely skips
format discovery or explicit task completion. A large improvement for a new URL
will require faster provider preparation or a separately qualified provider.

## Local validation

- Adapter unittest suite: 64 passed on Python 3.14 and production-matching
  Python 3.12.13, including real HTTP/1.1 keepalive fixtures, TLS EOF recovery,
  certificate rejection, truncated responses, cancellation and POST isolation.
- Backend `pnpm run verify`: formatter, lint, type checks, secret/transfer
  checks, 1,021 unit tests, 158 HTTP tests and compiled build passed.
- `pnpm run test:imports:integration`: 16 passed, including the new HTTP
  admission/replay/blocked-acquisition regression.
- `pnpm run test:processing:integration`: 17 passed.
- Touched Markdown/integration-file Prettier checks and `git diff --check`
  passed. No new dependency, environment variable or deployment was introduced.

API preflight: [Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
read on 2026-09-30. Rules 104 (endpoint security), 149 (method semantics),
106 (compatibility), 176 (problem JSON), 177 (no stack traces) and 155
(responsiveness) shaped the change. No wire schema, auth or response semantics
were changed.
