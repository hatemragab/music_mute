# W28 preferences and localization source checkpoint

Date: 2026-10-09. Scope: code, temporary fixtures and headless React tests on the Mac.

## Implemented source

- Strict device-only preferences, DPAPI storage, serialized updates, known-version migration and explicit reset retaining damaged data. Unknown future versions are not silently overwritten.
- System/Light/Dark appearance, four reviewed accents, the macOS text-size scale, Automatic/English/Arabic, default import source, player expansion, last-page restoration and saved playback volume/mute/rate.
- English/Arabic catalog with translation-key and dynamic-placeholder checks, Arabic plural handling, RTL document/layout behavior, mixed-direction content isolation, and the existing licensed Noto Sans Arabic asset.
- Windows keyboard controls that preserve editing and button activation, route-heading focus, modal Escape/focus trapping and restoration, responsive controls, forced-colors and reduced-motion CSS.
- Typed main/preload/renderer composition. Processing mode keeps the existing independent cloud-mode authority.

## Executed checks

- Focused integration checkpoint: 71 tests across 12 files passed, covering preferences, locale switching, translation completeness, modal focus, Library, cloud confirmation and player behavior.
- Desktop TypeScript passed after concurrent protocol changes settled.
- Source build passed with the bundled font and browser-host agent. Two renderer/preload package-boundary fixtures passed; the only renderer asset import is the bundled licensed font.
- Scoped lint: 39 files, zero warnings/errors. Formatting is checked separately in the progress record.

## Remaining work

The later Worker Advanced, Storage, update, diagnostics and outbox UI source is
now composed. Its final modal, simple-defaults, keyboard and asset audit is
recorded in [W28 composed accessibility](W28-composed-accessibility-2026-10-09.md),
including 153 focused tests in 19 files. That later checkpoint supersedes this
record's original source-composition gap while preserving the earlier counts.
Real native dialogs and shared-extension/Windows rendering acceptance remain
deferred.

No Electron/browser UI, Windows screen reader, fonts on Windows, high contrast, native theme/DPI changes or installation tests were run. Those scenarios remain in W34.
