# Rules for the implementation agent

These rules apply to every task. Read repository-level and directory-level `AGENTS.md` files when present and the existing `CONTRIBUTING.md`; do not overwrite them with this file.

## Scope and authority

Work only on the explicitly assigned branch. You may inspect code, implement its tasks, run isolated tests, create local commits, push that branch, and open/update its PR against `codex/worker-rebuild`. Do not merge PRs, push directly to the collection branch, enable auto-merge, deploy, publish npm packages, rotate production credentials, change production data, or modify `main` without an additional explicit maintainer instruction.

Inspect workflows, package lifecycle scripts, and deployment hooks before the first push. If a push or PR would automatically deploy or expose secrets, stop and report the trigger rather than relying on the branch name to protect production. A successful local build is not permission to deploy.

Default to one branch per assignment. Maintain checkpoint reports as work proceeds. Do not silently skip a failed checkpoint, weaken assertions, fake a backend response, or label simulated GPU tests as real. An authorized follow-up assignment begins only after the preceding PR is merged and accepted.

## Git and secrets preflight

Before making changes, inspect `git status`, current branch, remotes, and `git diff`. Do not discard unrelated work, use `reset --hard`, force-push, remove arbitrary untracked files, or recreate `codex/worker-rebuild`. If the branch exists, inspect it and resume only when it is clearly the intended work.

The current root ignore file covers `.env` and `.env.*`, but **not** `.local.env`. Before staging anything, ensure `.local.env` is ignored. On the documentation-only branch, add an exact local exclude through Git's local exclude file; do not edit tracked code/config merely to import documentation:

```sh
exclude_file="$(git rev-parse --git-path info/exclude)"
printf '\n# Local Music Mute integration secrets\n.local.env\n' >> "$exclude_file"
git check-ignore -- .local.env backend/.local.env
```

Only the relevant actual paths need to exist; absence is not evidence that future files are safe. Check whether any such file is already tracked using `git ls-files -- .local.env backend/.local.env`. If it is, do not print its contents or proceed with a push; report the exposure for credential handling. In the control-plane branch, add the tracked `.gitignore` rule and regression test.

Stage explicit paths, never use indiscriminate `git add .`. Review the staged diff and filenames before every commit. Do not include `.local.env`, ordinary `.env` files, S3 URLs, enrollment tokens, machine secrets, SSH details, raw user audio, model weights, caches, binaries, production exports, or log dumps with credentials. Examples use obvious placeholders or synthetic fixtures only.

## Environment boundaries

Load owner-provided `.local.env` only inside the test/backend process. Do not shell-source arbitrary dotenv content, print the environment, inherit it into the agent/Python child environment, copy it to Windows, or put it in a service configuration. The real worker uses a machine credential and temporary job grants, never AWS/database/Redis credentials.

Use a unique test-run ID, isolated local replica-set database name, Redis instance/key namespace, and dedicated S3 test prefix. Verify the namespace before writes or cleanup. Delete only objects/versions and database resources created by that run. Never use `FLUSHALL`, broad bucket deletion, or production destructive tests. Follow existing storage preflight; do not weaken it to fit the test bucket.

The root `.local.env` is not automatically loaded by existing Nest configuration, which selects `.env.<APP_ENV>`. Implement a **test-runner-only** explicit dotenv path in branch C. Preserve production env-loading behavior. Avoid committing real environment values even in evidence reports.

## Hardware and operating-system actions

Run M4 tests first on the actual development Mac. An assistant container, hosted Linux runner, or CPU simulation cannot attest Apple GPU support. Connect to the Z440 only after the owner supplies an SSH target and trusted host-key information. Do not scan the network, guess passwords, disable host-key checks, or claim a connection succeeded without evidence.

Dedicated local service installation and non-disruptive service tests are in the implementation scope, using normal administrator consent where required. Never collect or hardcode the owner's administrator password. Do not automatically log the owner out, reboot a host, change a GPU driver, disable encryption/security controls, or disconnect the host's network. Schedule those disruptive acceptance tests with the owner and record exact results.

## Engineering boundaries

Keep the existing backend and dashboard structure. Do not restore the removed worker. Do not introduce Kubernetes, a second queue authority, a repository-wide tool migration, arbitrary workflow execution, or a public worker marketplace. Respect public job/history/account/usage contracts. Internal worker fields must not leak into public serializers.

Use tested pinned artifacts. Never resolve `latest` dynamically in a production installer. Dependency/version and checksum selection belongs to actual feasibility and packaging work, not guessed values in a design document. Do not downgrade security checks to make unsupported acceleration appear supported.

## Evidence and handoff

Use `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED`, and `SIMULATED` explicitly. Record commands, exit status, environment class, commit, short sanitized results, and limitations. A test report must not contain the secret file's contents, access URLs, or SSH keys. Use `templates/CHECKPOINT-REPORT.md` and `templates/PULL-REQUEST.md`.

At a branch boundary, report the branch/commit, PR URL, checkpoints, tests actually run, unsupported hardware, and remaining blockers. Stop for review. Automatic fleet updates are post-MVP, and no design document grants permission to update or deploy the real production fleet.
