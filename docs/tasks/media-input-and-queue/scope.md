# Accepted media and queue scope

**Status: product choices and implementation approved. See [execution.md](execution.md) for deployment authorization, verification, and remaining hardware qualification.**

## Product behavior

| Requirement | Accepted behavior | Tasks |
| --- | --- | --- |
| Common input formats | Support common audio/video containers and codecs that the device can safely inspect and prepare. Publish only verified capabilities. | R01, A01, I01 |
| Duration | Audio files, local videos, and individual recorded YouTube videos must be greater than zero and at most 1,800 seconds, inclusive. Reject longer input; no trimming UI or silent truncation. | B01, W01, A01, A03, I01, I03 |
| Local preparation | Copy compatible audio unchanged; extract compatible video audio without re-encoding; convert locally when encoding or prepared size requires it. Reject unsupported local preparation; no original-video/server-conversion fallback. | A01, I01 |
| Quality | Preserve compatible tracks. When conversion is necessary, prioritize quality; the proposed shared profile is AAC-LC/M4A at 256 kbps for ordinary mono/stereo sources, validated in R01. Do not silently downmix multichannel or spatial audio in the first version; reject if it cannot be preserved within tested support. | R01, A01, I01 |
| Track selection | Use the default audible track, or the sole audible track when no selection group exists. If the default is absent, ambiguous, silent due to no samples, or unusable, explain the failure; do not switch languages/commentary automatically. Multiple speakers within one soundtrack remain included. | A01, I01 |
| Result | Send only prepared audio to S3/server processing. Return cleaned audio only through existing on-demand Play/Download/Share. No video reconstruction or local AI separation. | B05, W01, A02, I02 |
| Picking | Individual submissions; audio through Files, video through Files or the photo library. Preserve display name, consent, and automatic processing behavior already present. | A02, I02 |
| Progress | Cancellable preparation, download, upload, queue, and processing stages; distinguish active work from waiting. | A02–A04, I02–I04 |
| Background work | Continue where supported; persist recovery state and use bounded retries. Do not promise continuous iOS processing after suspension/force-quit or unsupported Android background operation. | A02, I02 |
| Storage | Check source size/duration and space early; avoid full-video copies when possible; keep prepared audio for upload retry and remove its temporary copy after server-confirmed upload. Preserve source media and separately saved library files. | A02, I02 |
| Account protection | One unfinished job per authenticated account across input sources and devices; 3,600 audio seconds per rolling 86,400 seconds by default. | B02, A04, I04 |
| Prepared size | Starting limit: at most 100,000,000 bytes (decimal 100 MB), subject to fixture validation. Original source limit is separate. | R01, B01, W01 |
| YouTube bounds | Reject playlists, live/upcoming streams, and safely unmeasurable duration. Metadata preflight before audio download; enforce byte/time limits while streaming and revalidate downloaded audio. | A03, I03 |
| Fairness | Favor users with lower recent worker consumption and shorter work, with aging to prevent starvation. Running work is not preempted. | B04 |
| Saturation | Reject new reservations before upload when the job-count or workload ceiling is reached; show a useful busy explanation. | B03, A04, I04 |
| Usage settlement | Release pre-processing cancellation reservations; restore allowance for service-caused failures. Debit verified work after user cancellation during processing. Bound attempts separately from refundable allowance. | B02, B05, W02 |
| Admin exceptions | Authorized administrators can temporarily raise an account allowance or suspend processing, with reason, expiry, revision protection, and audit record. Exceptions never bypass physical media/worker safety ceilings. | B06, D03 |
| Policy updates | Ordinary changes apply to new admissions. Retain accepted policy snapshots for existing work; explicit emergency cancellation remains separate. | B01–B03, B05, D01 |
| Visibility | Show reserved/used/remaining allowance and the next replenishment time; show an estimated wait range only when evidence supports it. | B06, A04, I04, D02, D03 |

## Architecture boundaries

- Extend existing job lifecycle and request/event idempotency. MongoDB remains authoritative for queue, reservations, settlement, and policy. Redis remains bounded signaling/request protection; do not migrate the queue to BullMQ/SQS.
- Server enforcement cannot depend on client-supplied source type, duration, or UI restrictions. Prepare locally for user experience; validate remotely before AI execution.
- Do not create a reservation holding worker capacity while downloading or converting locally. A nonbinding authenticated availability read may precede preparation; atomic admission after preparation is definitive and may still reject a now-full queue.
- Count upload reservations against account and global outstanding budgets with expiry. They do not occupy an actual worker slot.
- Preserve worker lease/generation/ownership fences, machine exclusion, process containment, safe recovery, account suspension/deletion behavior, and direct immutable S3 upload identity/checksum protection.
- Policy compatibility must cover old app parsers, old dashboard updates, old accepted jobs, and old workers. Do not silently reinterpret version 1 exclusive limits as version 2 inclusive limits.
- Benchmark unknown/offline/stale readings are unavailable, never zero capacity or zero execution time. Queue estimates cannot promise a fixed place in a fair scheduler.
- Common-format support does not include DRM bypass, protected media, damaged/undecodable files, original video server fallback, new media rights rules, or a broad native FFmpeg dependency. Preserve current consent and YouTube disclosures.
- No new worker slots, live worker operation, migrations, hosting, infrastructure, forced updates, store publication, commits, or deployment are authorized by this planning package.

## Validation constraints

- Device/UI tests may run only on existing **iPhone 17 Pro / iOS 26.0**, UDID **3CC14436-EC3C-4419-A079-C84951E5FA07**. If absent, report blocked; do not create or substitute a device.
- Android JVM tests, lint, and builds are allowed during authorized implementation. Android emulator/device tests are outside current authorization, so Android decoder, picker, and background hardware proof must remain explicitly unverified unless the user later changes that constraint.
- A simulator is not proof of physical-phone thermals, real iCloud behavior, or indefinite background execution.
- Windows benchmarks require an authorized idle/offline test environment with no live claims, credentials, or production data. Do not stop a live service automatically to obtain that environment.
- Use synthetic fixtures and isolated services; preserve existing files and credentials. Do not check large generated media or private/user media into the repository.
