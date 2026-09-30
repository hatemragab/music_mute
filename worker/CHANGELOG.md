# Changelog

## 0.1.2 — 2026-09-30

- Replace S3 version IDs with quoted ETags and checksum-bound create-only uploads.
- Update installer qualification and worker transfer contracts for private R2.
- Require matching signed platform runtimes and verified private R2 artifacts;
  earlier published runtimes use the incompatible object-version contract.

## 0.1.1 — 2026-09-30

- Use `npm.cmd` and `mw.cmd` in Windows PowerShell installation instructions so
  the default Restricted script policy accepts the commands.
- Retain the accepted signed `0.1.0` runtimes; this CLI patch changes documentation
  and the reported CLI version.

## 0.1.0 — 2026-09-30

- Share the npm CLI between Apple Silicon macOS and Windows x64/DirectML.
- Add native Windows lifecycle, diagnostics, signed updates and recovery commands.
- Verify signed metadata for initial runtime downloads before extraction or execution.
- Validate Windows enrollment-file and staging-directory ACLs before reading credentials.
- Preserve slot identities across one/two-worker transitions and runtime updates.
- Enable two workers only after native qualification and backend capacity approval.
- Allow progressing runtime downloads up to one hour on slow connections, retaining the thirty-second inactivity timeout and full integrity verification.
- Resume exchanged enrollments with the saved installation credential after the invitation expires; replay uncertain activation without repeating its qualification report.

## 0.1.0-rc.1 — 2026-09-27

- Public npm release candidate for the Apple Silicon macOS installer. Publication,
  fresh-machine acceptance and runtime catalog promotion remain separate gates.
- Clean every TypeScript build; verify an exact npm file inventory and install
  the packed artifact in an isolated consumer before release.
- Add `mw --version [--json]` to distinguish CLI and installed runtime versions.
- Update two-worker installations with one worker per GPU until the new release
  is qualified. Restore the previous configuration during rollback and preserve
  paused/stopped intent. Expired capacity receipts no longer block update checks.
- Validate runtime configuration before committing updates of stopped services.
- Restore a legacy-compatible rollback journal before restarting older binaries;
  retain retryable restart intent if restoration fails.
- Require the worker and Node license notices in macOS runtime packages.
- Keep npm CLI upgrades separate from signed, manual service runtime updates.

Earlier `0.1.0-mvp.*` builds and `.local.*` runtimes were private development
artifacts. Their historical measurements are not acceptance of this candidate.
