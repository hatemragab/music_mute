# Changelog

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
