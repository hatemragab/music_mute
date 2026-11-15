# W09 readiness implementation evidence

Date: 2026-10-09. Status: in-progress; native execution and remaining cross-process composition are pending.

## Source behavior

`windows-desktop/src/main/prepare/readiness-cache.ts` publishes a private atomic
fingerprint capsule followed by a small DPAPI marker. The binding includes the
Windows user, installation ID, active target/sequence, manifest/model/fixture
digests and strict DirectML policy. Each runtime file, manifest, model and fixture
has a filesystem identity and size/time fingerprint. A zero file ID, replaced or
missing file, changed driver/device, damaged capsule or changed activation marker
invalidates the cache. GPU ordinal reordering for the same physical adapter is allowed.

`WindowsPreparationOperations` writes the cache after full activation and checks
it on an ordinary launch. `PrepareController` accepts this shortcut only for a
complete matching journal under the native Prepare mutex. First install,
interrupted activation, changed identities and explicit repair use full verification.
The cache does not authorize execution: the session/runtime/engine keep their own
integrity and mandatory GPU checks.

Checks are bounded to an eight-second deadline, four concurrent metadata reads,
8,192 files and a two-MiB capsule. Unsupported or larger inventories use full
verification rather than a false cache hit. Local timing and operation-count
measurements are available; no Windows startup latency is claimed.

An already activated exact artifact can open offline after metadata expiry only
when its signature still verifies with the currently packaged trusted keys at its
DPAPI-recorded activation time. Target and sequence must match and rollback remains
blocked. A fresh install, altered signature, future/invalid activation or different
artifact cannot use this exception. No auth/update network request or fleet claim
is required to answer local readiness.

## Executed code checks

- Focused readiness/preparation/qualification/receipt/host suites: 49 tests passed
  across five files. These use deterministic native/GPU ports and temporary signed
  metadata, without Windows or Electron execution.
- Scoped root preparation and host lint: zero warnings/errors.
- Desktop TypeScript: passed after the current personal/session gateway contract
  was aligned. Later concurrent changes require another final component check.

## Remaining work

- Compose shared native-host/agent status consumers and activation callbacks; they
  must reuse this evidence without independently racing Prepare or trusting UI status.
- Extend fault fixtures around concrete filesystem/cache publication adapters as
  native and packaging integration lands.
- Measure real NTFS identities, ACLs, inventory sizes and deadlines in W34. Verify
  offline launch, file replacement and driver changes on both supported OS families.

All Windows acceptance boxes remain unchecked. These results establish code
behavior only; no installed Windows readiness, inference or startup timing was tested.
