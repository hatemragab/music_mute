# Deployment evidence — 2026-09-13

User authorized API/dashboard CapRover deployment and subsequently authorized the Z440 worker update over SSH. No Git commit/push was made.

## API

- Destination: `https://captain.music-mute.com`, app `api`, container port 80 unchanged.
- Previous image: `img-captain-api:33`.
- Uploaded archive: `/var/folders/jh/kqzv5jvj1qgfq85qwnwclz4w0000gn/T/musicmute-caprover-0kcatK/api.tar`, 1,855,488 bytes, 270 members.
- SHA-256: `008814e8554724606ad842bf65d3f48b5b7548d925fd6a477c8478440883ac31`.
- Allowlisted archive inspected: no credentials, environment files, private state, dependencies or generated build directories included; root definition targets `./backend/Dockerfile`.
- CapRover build finished successfully and version history shows current `img-captain-api:34`.
- Live read-back at 2026-09-13T13:49:54Z: `/api/v1/health/live` and `/api/v1/health/ready` both HTTP 200, `status:ok`.
- `/api/v1/processing-policy?schemaVersion=2` returns schema 2, inclusive 1800 seconds/100,000,000 prepared bytes, one active job, 3600 audio seconds/86400-second window; expanded admission/long jobs false, source/preparation bounds null, compatibility unavailable.
- Existing `/api/v1/processing-policy` returns schema 1 and `acceptNewJobs:true`. Expanded qualification was not invented or activated.
- A follow-up archive fixes the worker management CAS race found during live maintenance: `/var/folders/jh/kqzv5jvj1qgfq85qwnwclz4w0000gn/T/musicmute-caprover-xO6u3c/api.tar`, 1,856,512 bytes, 270 members, SHA-256 `0841659794ea904644d462ef7e948a5f915c9273a6f5e2b29c2f25eb46657078`. Stable management revision is separate from the internal worker authority fence; no dashboard contract change. Final verification passed 807 unit, 148 e2e and 13 real-Mongo worker integration tests, plus full backend verification.
- Follow-up deployment succeeded as `img-captain-api:35`. Public live/ready checks both return `status:ok`; expanded policy remains schema 2 with admission/long jobs false pending qualification.

## Dashboard

- Destination app `dashboard`, previous image `img-captain-dashboard:4`.
- Uploaded archive: `/var/folders/jh/kqzv5jvj1qgfq85qwnwclz4w0000gn/T/musicmute-dashboard-caprover-yVgvqe/dashboard.tar`, 1,155,072 bytes, 155 members.
- SHA-256: `a61cfe5ffcc3045c959835bb912ce09c9dac8d382d7f6a40da281402d00c7c5f`.
- Archive exclusions and correct dashboard Dockerfile definition verified. CapRover build succeeded and current version is `img-captain-dashboard:5`.
- Live authenticated Settings read-back shows version 2 media policy, 30-minute/100 MB inclusive limits, 60-minute rolling allowance, queue ceilings, and qualification unavailable. Health reports healthy dependencies and zero active alerts. No qualification or policy values were changed.
- Uploaded source files match the current checkout; only generated archive-root `.dockerignore` and `captain-definition` differ as expected. Four shared public asset hashes match the local build. Main JS/CSS filenames differ between the container and local builds, so byte-for-byte identity of those generated bundles is not claimed.

## Z440

- Current authenticated dashboard showed Z440 Enabled, Online, Available, with no current job.
- Initial key authentication failed. User then supplied password authentication, which succeeded as `hatem@192.168.1.110`; no credential was saved to project files.
- Worker package built and ZIP integrity checked: `windows-worker/dist/MusicMuteWindowsWorker.zip`, 94,920 bytes, 36 members, no private configuration/state. SHA-256 `a3b0190b69c6aef706ff6f06ea0a6671b37c107c85199be11590b03bda23bb06`.
- Transferred ZIP checksum matches. Existing scheduled task points to `C:\Users\hatem\Desktop\work\music_remover\MusicMuteWindowsWorker`; existing Python environment and null active journal verified.
- Staged Windows package suite: 157 tests in 62.363 seconds, OK with two skips. Package excludes the local packaging tests from its deployed suite.
- Installation completed after stopping only the idle scheduled worker and verifying a null journal again. First attempt stopped before copying while Windows process termination was pending; after verifying no Python processes remained, installation resumed successfully.
- Every installed source file hash matched staging. Existing source backup: `C:\Users\hatem\MusicMuteWorker-backup-20260913`. Configuration, DPAPI credential, Python path, installation identity and session file hashes remained unchanged. Models, environment and state were preserved.
- `Start-Worker.ps1 -Check` passed separator syntax, FFmpeg, FFprobe and DirectML; installed versions reported audio-separator 0.47.0, onnxruntime-directml 1.24.4, numpy 2.5.3, soundfile 0.14.0. Scheduled task restarted and reports Running.
- Live dashboard read-back at approximately 17:04 Cairo: Z440 Enabled, Online, Idle, Available, no recovery required, fresh expanded-media v2 capability. Queue read-back shows zero queued/outstanding jobs and unavailable estimated work/wait, consistent with missing benchmark evidence.
- Existing output cap is 30,000,000 bytes and processing timeout 7200 seconds; preserved during update and must be reconciled with measured 30-minute output/processing requirements before expanded activation.
- This update/check is not an end-to-end queued separation or physical 30-minute benchmark. Expanded admission remains gated by measured qualification.
- During maintenance, dashboard drain exposed an existing hot-revision conflict: worker claim/heartbeat updates invalidated admin CAS. Fixed in API v35 with a stable management revision while preserving internal fencing. Live audited drain and re-enable both succeeded at approximately 17:10 Cairo; management revision advanced 0 → 1 → 2. Final state is Enabled, Online, Idle, Available, no active assignment and no recovery required.
