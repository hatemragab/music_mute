# F01 review

**Verdict:** Changes requested. The candidate manifest currently fails closed because every listed recipe is `unavailable`, and the focused suite passes. The implementation is not yet safe to use for promotion/admission. Hardware qualification remains correctly blocked until real native evidence exists; this review does not request fabricated or unavailable hardware proof.

## Critical findings

### 1. A hand-edited `status: qualified` bypasses the immutable recipe and evidence policy

`worker/qualification/admission.py:21-44` validates only required-key presence, duplicate `profileId`, and three digests for a qualified profile. It does not validate `schemaVersion`, profile ID syntax, OS/architecture/provider/status enums, non-empty bounded strings, dependency package names or exact immutable pins, provider/package compatibility, evidence-check structure, driver constraints, or reject unknown fields. `validate_qualification` then trusts the caller-supplied profile's `status` (`worker/qualification/admission.py:51`) rather than requiring a separately approved/signed promotion record.

This is exploitable locally today: a copy of the first profile changed to `status="qualified"`, `dependencies={"onnxruntime-directml":"latest"}`, and `evidenceChecks=[]` was admitted with matching synthetic digests/counts. The profile is therefore not actually bound to the dependency recipe, driver constraints, expected execution checks, media limits, or an approved evidence artifact as required by `contracts.md` and F01.

Action: define and validate a strict manifest schema for all statuses, reject extra/malformed values, require exact immutable dependency/source/lock metadata for qualification, and make promotion depend on an independently verifiable approved evidence record rather than a mutable status string. Add tests that mutate every identity/security field independently (including `schemaVersion`, enums, profile ID, package pins such as `latest`/`9.x`, empty checks, provider/package mismatch, extra keys, limits, and approval/evidence binding) and assert load or admission fails closed.

### 2. Admission accepts incomplete and contradictory evidence and does not enforce the declared measured policy

`worker/qualification/admission.py:54-86` does not validate `serviceContextPassed`, `deviceLabel`, `reasonCodes`, bounded strings/numbers, reference metrics against recipe-bound tolerances, cold versus warm timings, peak GPU memory when required, or media-class limits. A direct probe was admitted with `serviceContextPassed=False`, `deviceLabel=None`, and `reasonCodes=["CPU_ONLY_UNSUPPORTED"]`. `referenceMetrics` is ignored, while one positive `wallMilliseconds` value substitutes for the manifest's cold-and-warm requirement. Arbitrary positive neural/accelerated counts are accepted without binding them to the recipe's signed profiling checks.

Action: introduce a strict offline evidence type whose required measurements and tolerances are recipe-bound, validate every field and contradiction, and require service-context evidence where the recipe declares it. Add rejection tests for false/missing service context, missing/oversized device label, non-empty failure reason codes on a purported pass, unknown fields, NaN/infinite/boolean/out-of-bound numerics, missing cold or warm measurement, reference metrics outside bound tolerances, required GPU-memory absence/excess, and unrecognized/unbound execution evidence.

## Important findings

### 3. The offline qualification evidence and wire `QualificationReport` are conflated

The contract's `QualificationReport` has no `runtimeLockSha256`, `executionEvidence`, `outputFinite`, `cancellationPassed`, or `longClipPassed`, yet `validate_qualification` requires those fields. Conversely, the contract permits nullable `peakRamBytes`, while this validator always rejects null as `INSUFFICIENT_MEMORY`. No adapter or documented trust boundary distinguishes contributor-reported runtime data from the independently approved native profiling evidence that may qualify a recipe. As written, a conforming wire report cannot pass this validator, while a non-contract synthetic dictionary can.

Action: document and type two distinct records: immutable offline qualification evidence used by the approval/promotion process, and the bounded contributor `QualificationReport` used to match an already-qualified signed profile. Define where runtime-lock and profiling artifacts are verified, and test that an exact contract-shaped report is handled according to that boundary without trusting self-attestation.

### 4. Candidate coverage tests encode only the current list and omit feasible ARM64 families

`worker/tests/qualification/test_recipe_manifest.py:15-34` considers coverage complete when eleven hard-coded tuples exist. The manifest does not include or explain Linux ARM64 NVIDIA/CUDA (for example Jetson), and it provides no explicit inventory of other omitted OS/architecture/vendor families with unsupported reasons. F01 asks for broad feasible ARM64 combinations and a reason for every unsupported or untestable family, so the test cannot detect a narrow or silently omitted matrix.

Action: create a canonical required-family inventory that includes feasible ARM64 targets and explicit unsupported entries/reasons, then derive the coverage test from it. At minimum add and truthfully mark Linux ARM64 NVIDIA/CUDA unavailable until native evidence and exact packaging are proven.

## Documentation completeness

At review time, `worker/qualification/README.md` and `docs/tasks/cross-platform-workers/evidence/hardware-matrix.md`, both required by F01, were absent. This makes the implementation incomplete independently of hardware qualification. Re-review those artifacts when added, especially redistribution provenance, immutable sources/notices, measured tolerance definitions, exact package compatibility, and the offline-versus-wire evidence boundary.

## Verification performed

```text
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification -p 'test_recipe_manifest.py' -v
Ran 10 tests in 0.002s -- OK
```

An adversarial Python probe calling `validate_qualification` with the mutable/contradictory data described above returned `AdmissionDecision(admitted=True, reason_codes=())`.

---

## Fix round 1 re-review — 2026-09-13

**Verdict:** Changes requested. Prior finding 4 is addressed by the Linux ARM64 NVIDIA candidate and explicit omitted-family discussion. Prior finding 3 is structurally addressed by separate offline and wire validators and documentation. Prior findings 1 and 2 are improved but remain open because malformed nested values can crash admission, qualification policy is not validated or safely bounded, and runtime matching accepts an arbitrary hash string instead of a trusted authority record. All manifest candidates remain truthfully unavailable; native hardware qualification is still correctly blocked and is not required for these code corrections.

### Critical: the runtime boundary does not require a trusted approval record

`validate_runtime_report` accepts `approved_evidence_sha256` as any syntactically valid 64-character digest (`worker/qualification/admission.py:53-64`). It neither consumes the trusted `ApprovedEvidenceRecord` used by offline admission nor verifies that the digest belongs to the profile through an authority-owned lookup. The current positive test passes a literal `"e" * 64` (`worker/tests/qualification/test_recipe_manifest.py:217-228`), demonstrating that knowledge of no approved evidence is required. If a caller forwards this value from contributor input, the contributor can cross the intended trust boundary and obtain an admitted runtime match.

Action: make runtime matching consume an `ApprovedEvidenceRecord` already loaded/authenticated by the release/V01 authority (or an authority lookup result), validate its `profile_id`, and keep evidence approval absent from the wire report. Add a test that an arbitrary valid digest string/client value cannot substitute for the trusted record. This does not require local cryptographic attestation; H01/B05 remain responsible for signing and authority integration.

### Important: malformed candidate/policy/approval types raise instead of failing closed

The public validators catch only `ValueError` from `_validate_candidate`, but its enum/provider checks operate on unvalidated values (`worker/qualification/admission.py:66-80`). A candidate with `os=[]` raises `TypeError: cannot use 'list' as a set element`. An `ApprovedEvidenceRecord` whose digest is an integer raises `TypeError` at line 46. The `qualificationPolicy` is accepted as an arbitrary mapping with no exact shape or field validation; setting `maxWallMilliseconds="5000"` reaches line 96 and raises `TypeError` during comparison. Similar malformed policy bounds can crash reference and memory checks.

Action: validate scalar types before enum/digest operations, define an exact policy schema with required keys and no extras, and validate every bound/Boolean/method before using it. The exported validators should return a rejection for all untrusted shapes. Add table-driven tests for lists/dicts/nulls/booleans in candidate enums, provider, approval fields, every policy field, and nested execution/reference values, asserting no exception and a fail-closed decision.

### Important: numeric bounds are policy-controlled or absent

Offline maxima are trusted directly from the unvalidated profile policy, with no implementation-level safe ceilings (`worker/qualification/admission.py:96-102`). The wire validator checks only positivity/finite values and admits arbitrarily large integers for time and memory (`worker/qualification/admission.py:62-64`); a probe with `10**100` for both `wallMilliseconds` and `peakRamBytes` was admitted. The contracts require the receiving service to enforce numeric bounds.

Action: define conservative absolute bounds for wire duration/memory fields and for the allowable policy maxima, then reject values outside them. Test zero, negative, Boolean, NaN, infinity, boundary values, and extremely large integers for every numeric field.

### Verification performed

```text
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification -p 'test_recipe_manifest.py' -v
Ran 16 tests in 0.006s -- OK
python3 -m json.tool worker/qualification/candidates.json
Exit 0
```

Targeted malformed-input probes reproduced the three `TypeError` failures and the unbounded wire admission described above. `worker/qualification/README.md` and `docs/tasks/cross-platform-workers/evidence/hardware-matrix.md` are now present and clearly distinguish implementation work from missing native qualification evidence.

---

## Fix round 2 re-review — 2026-09-13

**Verdict:** Changes requested for one remaining strict-shape issue. The three round-one findings are otherwise addressed: runtime matching now requires an authority-loaded `ApprovedEvidenceRecord`; the previously demonstrated candidate, approval, and policy type errors fail closed; and offline/wire numeric values have implementation ceilings with boundary tests. The offline/wire separation remains explicit. All manifest profiles remain unavailable, so implementation review does not imply native hardware qualification.

### Prior finding status

- **Trusted runtime approval record: addressed.** `validate_runtime_report` now takes `ApprovedEvidenceRecord`, verifies its profile binding, and rejects a plain digest string. Loading/authenticating that record remains correctly assigned to H01/V01/B05 rather than invented here.
- **Malformed nested inputs: mostly addressed.** Exact policy shape/types and the previously crashing candidate/approval cases now reject without exceptions. One admission gap remains below.
- **Safe numeric bounds: addressed.** Offline policy maxima, observations, reference values, node counts, and wire time/memory use finite absolute ceilings. Zero, negative, Boolean, NaN, infinity, and huge-number cases are covered.

### Important: two declared metadata/evidence types remain unenforced

`_validate_candidate` never validates `gpuVendor` (`worker/qualification/admission.py:181-219`), and `_validate_offline_measurements` uses truthiness rather than an exact Boolean check for `acceleratorUsed` (`worker/qualification/admission.py:260-277`). A targeted probe admitted a qualified profile with `gpuVendor=[]`; another admitted otherwise valid evidence with `acceleratorUsed=1`. This leaves strict profile metadata and offline evidence shape incomplete even though the equivalent wire flags use `is True`.

Action: require `gpuVendor` to be a bounded allowlisted string compatible with the declared OS/provider recipe, and require offline `acceleratorUsed` and `serviceContextPassed` to have exact Boolean types regardless of whether service context is policy-required. Add table-driven tests for list/dict/null/Boolean/string vendor values, vendor/provider incompatibility, and `0`, `1`, strings, and null in both offline Boolean fields.

### Verification performed

```text
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification -p 'test_recipe_manifest.py' -v
Ran 18 tests in 0.005s -- OK
python3 -m py_compile worker/qualification/__init__.py worker/qualification/admission.py worker/tests/qualification/test_recipe_manifest.py
python3 -m json.tool worker/qualification/candidates.json
git diff --check -- worker/qualification worker/tests/qualification docs/tasks/cross-platform-workers
All exited 0
```

Targeted probes returned `AdmissionDecision(admitted=True, reason_codes=())` for both `gpuVendor=[]` and `acceleratorUsed=1`. No new critical regression was found.

---

## Fix round 3 re-review — 2026-09-13

**Verdict:** Approved for the scoped F01 implementation. The remaining strict-type finding is addressed, and no adjacent critical or important regression was found. This approves the local manifest/admission implementation only; native GPU runs, fixture/reference evidence, dependency locks, redistribution review, service context, and reboot qualification remain separately incomplete. No candidate is marked qualified.

### Prior finding status

- **GPU vendor allowlist and provider compatibility: addressed.** `_validate_candidate` requires a string vendor from the provider-specific allowlist. The regression test covers malformed, unknown, and incompatible vendors.
- **Exact offline Boolean fields: addressed.** All seven offline flags are type-checked as exact Booleans before admission. The regression test rejects integer, string, and null substitutes for every flag.
- **Exact integer schema version: addressed.** `load_candidates` uses `type(value) is int`; targeted probes confirmed `True`, `1.0`, `"1"`, and null are rejected.
- **Verified model hash adoption: addressed.** All 12 still-unavailable candidates use `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`, matching the independently recorded Kim Vocal 2 identity in `model-artifact.md`. Fixture and runtime-lock identities remain unknown, so the model digest alone cannot promote a recipe.

### Verification performed

```text
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification -p 'test_recipe_manifest.py' -v
Ran 20 tests in 0.006s -- OK
python3 -m py_compile worker/qualification/__init__.py worker/qualification/admission.py worker/tests/qualification/test_recipe_manifest.py
python3 -m json.tool worker/qualification/candidates.json
git diff --check -- worker/qualification worker/tests/qualification docs/tasks/cross-platform-workers
All exited 0
```

Additional probes confirmed all 12 candidate model hashes match the recorded digest and non-integer schema-version equivalents fail closed.
