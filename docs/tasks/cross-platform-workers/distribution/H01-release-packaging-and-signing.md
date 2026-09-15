# H01: Build reproducible native release artifacts and signing workflow Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Produce immutable native packages and trust metadata for candidate qualification and evidence-qualified release profiles without publishing automatically.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** F01, W02, W03, W04, I02, I03, I04

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker/package.py, worker/release-manifest.schema.json, worker/scripts/verify_release.py and worker/tests/test_package.py.
- Create .github/workflows/worker-release-build.yml with a native OS build matrix, initially manual dispatch and artifact-only output.
- Create worker/docs/releasing.md, trust-root management instructions and package allowlists.
- Create per-profile lockfiles and launcher artifact definitions; include license/notices for exact redistributed assets.

## Interfaces

- Consumes fully specified profile/runtime/model identities, installer entrypoints and TUF trust client requirements.
- Produces WorkerReleaseTarget artifacts, standard TUF metadata, a declared publication bundle and safe build provenance. These are inputs to H02/B04, not automatic deployment authorization.

## Steps

- [ ] 1. Package code, launcher, profile runtimes and model references separately so routine code updates reuse large verified caches. Do not archive configured state, credentials, media, local logs or unrelated files.

- [ ] 2. Build environments or wheel assets for the native target rather than treating a copied virtual environment as portable. Verify architecture/platform tags and fixed artifact layout.

- [ ] 3. Validate each manifest against the declared schema, immutable build number and compatibility metadata. Candidate artifacts may be built for V01 hardware qualification, but unqualified recipes cannot enter the stable catalog.

- [ ] 4. Use short-lived online target signing and a protected offline/root trust workflow with rotation tests. Signing keys never belong in repository, backend images, command arguments or artifact logs.

- [ ] 5. Generate local test-signature fixtures for automated checks; production-signing and publishing are separate authorized actions. Pin build tools/actions and avoid executing unreviewed PR code with signing access.

- [ ] 6. Verify exact size/hash, extraction confinement, required notices, native signature/notarization where applicable and launcher compatibility floor.

- [ ] 7. Add build workflow artifact uploads only. Leave all release publication, stable selection and worker rollout as explicit steps from the dashboard/operator workflow.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: A configured worker directory is accidentally passed to packaging
  Given it contains credentials and active job media
  When the allowlisted release packager runs
  Then those files are absent from every archive
  And package verification rejects an unexpected sensitive path
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_package.py' -v
python3 worker/package.py --check
python3 worker/scripts/verify_release.py --self-test
```

## Completion evidence and limits

Native artifact hashes/architecture checks, allowlist/secret-exclusion tests, signed-fixture verification and documented root rotation.

Native build success is not GPU support. A hosted runner without the target GPU cannot populate qualified hardware evidence.
