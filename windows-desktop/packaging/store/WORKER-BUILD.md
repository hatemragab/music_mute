# Store Worker directory build

This producer creates a new, unsigned Worker directory. It does not sign,
install, publish, prove Store execution or approve third-party redistribution.
`worker.ts` accepts only the fixed Worker role and current source provenance;
GUI inputs cannot substitute for its native executable set.

The shared `buildWindowsConsumerPackage` **library** assembles an unsigned nested
directory; it does not read a signing key, create an archive or approve execution.
The separate legacy consumer-package CLI requires an external Ed25519 key before
it creates signed ZIP metadata. The Store producer imports only the library and
preserves that CLI entry guard when compiling its module closure. It does not
invoke the CLI, fabricate a publisher/signature, or change legacy installation,
Authenticode or update admission. Current freshly compiled unsigned native
executables are checksum-bound build material. An uninstalled build directory
has no installed-package authority, and a None-signature-kind-0 QA package cannot
satisfy the production Store runtime's independent signature-kind-3 gate.

Only the pinned offline dependency installer is adapted during nested assembly.
The source and relocated probes, x64 checks, complete 63-distribution lock,
legacy acquisition verification, native import/DLL audits and final manifest
checks still run. The directory receipt explicitly records `signed: false`,
`installable: false`, `storeExecutionQualified: false` and `releaseReady: false`.
No build-only receipt is accepted as a consumer runtime grant or Ready marker.

The build has separate phases:

1. Preserve official Node 24.18.0 and pnpm 10.14.0 archives and their complete
   build-tool provenance. `verifyStorePnpmTool` checks all 1,111 actual pnpm
   files, including its two genuine empty metadata/module leaves. These tools
   remain outside the consumer directory.
2. Use `prepareStoreProductionDependencyCache` in a separate, frozen original
   QA guardian invocation. It creates new private configuration, work and store
   roots, fetches only the current production lock from the official npm
   registry, and disables lifecycle scripts and package-manager replacement.
   Fetch completion is not offline installation or consumer qualification.
3. Prepare a separate Store-only Python projection under the original guardian.
   It excludes only twenty exact checksum-pinned leaves: nineteen installer/venv
   auxiliaries and the unused samplerate 32-bit DLL. The unchanged samplerate binding and
   its exact AMD64 DLL must match, and real source and projected import/function
   probes must process the same synthetic in-memory signal. Keep all 63 locked
   distribution metadata and license records. Every other retained native leaf
   must pass the strict x64 audit. A newly received projection receipt must
   revalidate both full held censuses before it can become a builder input.
4. Call `buildStoreWorkerDirectory` under the original guardian on native Windows
   x64. The real legacy consumer builder keeps its architecture checks, source
   and relocated Python/DirectML imports, exact distribution lock, acquisition
   validation and DLL closure checks. Only its production dependency installer
   is replaced by the actual pinned tool using offline, frozen-lockfile,
   no-script, hoisted and copy semantics.
   The shared compiler must first produce all six current Agent bundles and
   `dist/agent-build-inputs.json`. The receipt has version 1, purpose
   `store-agent-compiled-inputs`, compiler `esbuild` 0.28.2, the sorted union of
   source `{path, bytes, sha256}` records and six Agent records in the fixed
   order exported by `STORE_AGENT_ROLES`. Each Agent record binds its role,
   `.cjs` filename, bytes, digest and actual compiler metafile. All source and
   compiled pins are checked again before and after notice generation.
   The production build captures the individually held bytes esbuild actually
   parses, retains its returned output bytes, and rejects current source or
   output changes. The five Worker Node roles use only the literal
   `process.versions.electron: undefined` definition to remove the unreachable
   GUI factory branch; every actual GUI bootstrap gate is preserved in the GUI
   build. No external Electron resolver or runtime shim is allowed in a Worker
   graph. The sixth browser-host output remains separately GUI-owned.
   `copyStoreWorkerAgentInputs` copies only the five Worker-owned roles into a
   new private build directory; the browser host remains a GUI-owned artifact.
   Only the known pend/yauzl leaves are admitted as Worker third-party inputs;
   the Electron resolver may occur only in the GUI browser-host graph. Notices
   follow the five shipped Worker role graphs, including a truthful
   zero-third-party case, while all six source/output records remain verified.
   Exact existing package manifests and license texts for the observed modules
   are copied into `runtime/licenses/agent/bundled.txt` and checked
   against current source during the final audit. A compiler receipt or bundled
   notice does not establish execution authority or licensing approval.
5. Bind the current Store-only protected reader, Personal and qualification
   wrappers to their exact current source. Preserve the legacy qualification
   and Personal implementations unchanged. Add the Store-only downloader
   bootstrap, both genuine native
   entry executables and the complete qualified Deno cache. Regenerate the final
   release manifest and independently audit every consumer leaf. The ordinary
   downloader bootstrap and legacy acquisition verifier remain separate.
6. Run a new, guarded offline Canvas/provider rehearsal against the copied
   provider and complete cache, with an actual DACL denying writes to those
   exact owned code roots **before its first execution**. Do not prewarm the
   relocated writable cache. Preserve before/after held leaf censuses, private
   data inventory and verified restoration. A successful rehearsal at an older
   path does not qualify a new directory or an installed Store package.
7. Only after actual tool and functional receipts exist may a separate MSIX
   producer consume the audited directory. Native installed-package authority,
   Store signature kind 3, capability decisions, account/Chrome/worker/GPU
   acceptance, licensing review and publication remain independent gates.

`parseStoreBuildDocument` is a bounded on-disk build parser (8 MiB, 400,000
nodes, depth 32). It retains duplicate decoded-key and finite-number checks.
It does not increase ordinary IPC/HTTP parsing limits or confer OS authority.

Current qualified acquisition inputs use Deno 2.9.7, provider 2.0.1, downloader
2026.08.19 and the pinned Windows Canvas 3.2.3 archive. Their actual manual,
hoisted installation and protected cache are required. Do not replace Deno
with Node, copy protected executable code into writable cache, remove lock or
bookkeeping leaves, use ambient tools, skip default probes, relabel an older
payload or change the model recipe to make a build pass.

Device tool work must use a unique frozen source cohort, the original approved
native tool guard and fixed CMake targets. Keep requests, raw guard frames,
parsed cleanup confirmations, bounded decoded logs and exact task-definition
archives outside the repository. A wrapper exit, stopped Scheduler task or a
supplementary associated-Job observation is not a guardian cleanup certificate.
Any failure stays a failure until a new run supplies the missing evidence.
If the guard terminates a rehearsal before its `finally` block restores the
DACL, retain the failed receipts and use a separate, fixed, guarded restoration
recovery. Job-zero and Scheduler completion alone do not prove restoration.

On 2026-10-12, the Z440 `pyC-7668df08` input projection passed actual source and
relocated samplerate function probes on Python 3.12.10 x64: 10,052 selected
source leaves, the twenty explicit omissions, 10,032 consumer leaves and all 63
locked distribution records. These checks do not replace the default DirectML
probes in the full Worker producer.

The separate `dnC-29ded532` copied Deno input passed its first offline
Canvas/provider invocation with code and cache already protected by the own-QA
DACL. All 5,033 write-open probes were denied, the two fixed code/cache root
creation probes were denied, and every code/cache byte remained unchanged.
Actual original guardian Job-zero, full DACL restoration readback and exact
task retirement were verified separately. Preserve the earlier writable-cache
mutation failure and the separate QA argument-check failure; neither is a
qualified run. This is a functional input rehearsal, with owner-restorable
permissions, and does not establish Store signature or namespace authority.

The pinned [Deno 2.9.7 emit-cache implementation](https://github.com/denoland/deno/blob/v2.9.7/libs/resolver/cache/emit.rs)
tolerates read-only emit-cache writes, and its
[analysis-cache implementation](https://github.com/denoland/deno/blob/v2.9.7/cli/cache/node.rs)
selects an in-memory cache when the on-disk cache fails. The actual protected
execution and full unchanged census are required evidence; these source
behaviors alone do not qualify a payload.

The author's [samplerate 0.1.x binding source](https://python-samplerate.readthedocs.io/en/latest/_modules/samplerate/lowlevel.html)
selects the Windows DLL according to the interpreter architecture. This source
observation supports the bounded 32-bit omission; it does not replace actual
source and relocated x64 function probes or approve redistribution.
