# W01 source movement observations

Use `../worker/W01-shared-core-and-state.md` and the shared contracts as requirements. These are source-inspection observations to avoid a partial move.

- `windows-worker/package.py` copies `backend/separate.py` into the ZIP. `windows-worker/tests/test_package.py` asserts those bytes. Both must change with the worker-owned separator move; do not retain a second engine copy.
- `windows-worker/tests/test_separator.py` resolves the separator in both the repository and old packaged layout. Replace that old-layout branch with the new shared source identity.
- Worker config and entrypoint, benchmark/progress/worker/reliability tests, and the example config reference `separate.py`. Synthetic separator scripts in tests may remain separate fixtures, but production paths must be explicit and rooted in the selected release.
- Root `README.md` advertises Windows/DirectML and links the Windows folder. The old worker README documents the old ZIP/source-copy shape and must be replaced with accurate native installer/shared-core instructions.
- Existing baseline on this macOS host: `PYTHONPATH=windows-worker python3 -m unittest discover -s windows-worker/tests -q` ran 161 tests, OK with 23 skipped. Preserve those meaningful behavior checks through movement. The result is not native Windows proof.
- F01's `worker/qualification/` is already present and reviewed. Do not overwrite it or its tests when creating the shared package. Exact model identity and a deterministic smoke-fixture recipe are in `model-artifact.md` and `synthetic-fixture.md` here; actual recipe promotion remains incomplete.

No deployed folders, live worker processes, credential stores, or real journals have been inspected or changed by this movement preparation.

W01 also owns the minimal backend identity-response correction discovered during
extraction: `WorkerIdentityService.describe` advertises protocol 3 but currently
omits installationId. Return the installation ID from the current authenticated
registration binding (worker ID plus credential digest), with clear rejection of a
missing/mismatched binding. Add focused backend coverage. Do not add an old-client
fallback or independently change updateCapability in this task.

Paired identity is durable: setup-token expiry must not replace its installation ID
or permanent token. B02 now provides permanent-auth qualification for updates and
repair after expiry. An expired, never-approved provisional setup can start a new
reporting session only through an explicit fresh setup; I01 must use fresh pending
credentials because B02 permanently reserves a previously issued digest to its
original owner. This is distinct from paired-worker repair and must never discard
an owned assignment journal.

W02 must also consume `dependency-metadata.md`: direct PyPI checks found a Python 3.11/NumPy 2.5.3 conflict and no macOS x64 wheel for the proposed ONNX Runtime 1.24.4. Candidate inventory labels are not installable locks.

## Existing test gates to preserve

A source-only scan found native Windows gates for Job Object handle lifecycle,
termination handles, stop snapshots, supervisor-crash descendant containment and
the machine-wide mutex across different state folders. Preserve these native
checks rather than replacing them with mocks that always run on the current Mac.
The POSIX process exit race has its own platform gate.

Other skips are dependency gates: FFmpeg/ffprobe for worker, warm-worker and
reliability tests; NumPy/soundfile for separator parity and local integration;
PowerShell for installer mocks. Report these categories separately after moving
the suite. Missing optional local dependencies do not prove Windows service safety
or GPU parity, and a PowerShell mock is not a native boot test. This inventory did
not rerun the earlier baseline or install dependencies.
