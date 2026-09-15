# Contributing to MusicMute

Start with the [README](README.md) and the setup guide for the affected component.
Search existing issues and source code before proposing a new feature or utility.
For changes spanning the API, apps, and workers, describe the contract change and
compatibility impact in an issue before starting a large implementation.

## Local development

Clone `https://github.com/hatemragab/music_mute.git` and create a focused branch.
Each component owns its dependencies and commands; there is no root package install.

| Component      | Guide                             | Relevant checks                                  |
| -------------- | --------------------------------- | ------------------------------------------------ |
| Android        | [Setup](android/README.md)        | Gradle build, lint, and unit tests               |
| iOS            | [Setup](ios/README.md)            | Xcode build/tests and Swift formatting           |
| Backend        | [Setup](backend/README.md)        | `npm run verify`; relevant infrastructure suites |
| Dashboard      | [Setup](dashboard/README.md)      | Format, lint, typecheck, tests, and build        |
| Shared worker | [Setup](worker/README.md) | Worker tests and packaging checks                |

Run commands from the component directory. Follow the existing simulator policy
in the iOS guide for runtime/UI checks; do not automatically substitute devices.
Documentation-only changes need link and formatting checks rather than app builds.

## Change guidelines

- Keep changes focused and follow existing architecture, naming, and formatting.
- Preserve compatibility between clients, API contracts, and worker versions.
- Add meaningful tests for behavior changes, including failure and recovery paths.
- Update component documentation when setup, configuration, or behavior changes.
- Do not include credentials, `.env` files, production Firebase configuration,
  signing materials, personal audio, or user data in commits or attachments.
- Use synthetic test data and redact logs before sharing them.

## Bug reports and feature requests

Use the repository's issue templates. For bugs, include the component, revision or
app version, environment, reproduction steps, and expected versus actual behavior.
For features, explain the user problem and a concrete example of the desired result.
Do not post exploit details or sensitive data in public issues.

## Pull requests

Explain the problem, the resulting behavior, and the checks you actually ran.
Include screenshots for UI changes when useful, with personal information removed.
Clearly distinguish local tests, fixture tests, device checks, and live-service
verification. Report skipped checks and blockers instead of marking them passed.

Review the diff for unrelated changes and generated files before submitting.
Do not deploy, migrate production data, or change live services as part of a PR
without explicit maintainer authorization.
