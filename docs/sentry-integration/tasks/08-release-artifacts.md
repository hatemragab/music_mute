# SEN-08 — Release identity, source maps and native symbols

Status: TODO. Priority: P0 release gate. Dependencies: corresponding SEN-02–07 builds.

## Work

1. Generate immutable component/revision metadata in the existing release paths.
   Backend/dashboard package versions are placeholders today; do not use those
   values alone as production release identity. A reused version with changed
   bytes must get a distinct build identity.
2. Produce matching TypeScript source maps for backend/worker and hidden Vite
   maps for dashboard. Configure supported debug-ID/release association, inject
   IDs before artifact finalization, and test original-file frame resolution.
3. Remove dashboard maps from served output; verify a guessed `.map` URL returns
   no map bytes, even when the SPA fallback responds. Review whether maps include
   source content and document the external source-code upload scope.
4. Configure Android mapping uploads only where minification produces mappings;
   do not claim R8 proof for non-minified builds. Audit release settings before
   changing them. Collect eligible native debug symbols where available and
   report limitations for prebuilt third-party media libraries.
5. Generate iOS Release dSYMs and match their UUIDs to the archive/binary. Use a
   controlled upload script without embedding tokens in XcodeGen/project files.
   Do not globally disable Xcode script sandboxing.
6. Keep Python source filenames/line information usable without user home paths
   or local variables. Python SDK does not supply symbolic stacks for every
   native GPU/FFmpeg failure; report actual coverage.
7. Make upload operations explicit release steps using a scoped build credential.
   Local builds/tests without a token succeed without upload. Authorized
   telemetry-enabled production releases must gate publication on required
   artifact upload/verification, with retry evidence instead of silent success.
8. Scan final packages, CapRover archives, browser bundles and container layers
   for synthetic secret sentinels and prohibited config files. Avoid Docker ARG
   or ENV secrets that remain in image history; use the chosen release runner's
   secret mechanism. Upload before finalization only if it does not mutate the
   final bytes; do not modify hashed/signed worker releases afterward.

## Acceptance

- [ ] Every event has the release/dist matching the installed/deployed artifact.
- [ ] Required artifacts resolve a synthetic error to the expected source file/line.
- [ ] Upload credentials appear in no distributable or logs.
- [ ] No dashboard map can be downloaded from production serving fixtures.
- [ ] Upload-disabled developer builds work; production artifact gate is explicit.
- [ ] Source upload approval and provider receipt are recorded for real uploads.

Existing relevant paths: backend/dashboard `Dockerfile` and
`scripts/package-caprover.mjs`; worker `tsconfig.build.json`, release builders and
manifests; Android app Gradle file; iOS `project.yml`. No release workflow or
provider upload was run during planning.
