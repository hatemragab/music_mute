# MusicMute

- [android/](android/README.md): native Kotlin Android application (`com.hatem.musicmute`).
- [ios/](ios/README.md): native Swift/SwiftUI iOS application (`com.hatem.musicmute`).
- [backend/](backend/README.md): authenticated NestJS API, durable audio-job coordination, private S3 storage, external worker protocol and notification outbox.
- [dashboard/](dashboard/README.md): private browser operations console and its separate CapRover package.
- [windows-worker/](windows-worker/README.md): Windows Z440 supervisor, using the proven DirectML separator, with setup scripts and a portable package.

Both apps make local audio import the primary flow. Selected audio is reviewed with
an explicit rights confirmation before upload and processing. YouTube remains a
secondary feature with an explicit download action; original downloads stay private.
The processed library tracks cloud jobs and retrieves voice-only MP3 output on demand. See the
[mobile processing tracker](docs/tasks/mobile-audio-processing.md) for implementation
status, local test results and separate live-service validation requirements.

Account deletion is available in both apps with recent authentication, durable
request recovery and account-scoped local cleanup. The backend coordinates worker,
storage and identity deletion. Public `/delete-account` and `/privacy` pages require
operator-supplied publication settings. See the [implementation and validation record](docs/validation/2026-09-10-store-readiness.md)
and [deletion operations guide](backend/docs/account-deletion.md).

Both apps use `com.hatem.musicmute`. This replaces the earlier development ID
`com.hatem.vocal`; the operating systems treat them as separate apps, so old
private downloads and settings are not migrated automatically.

## Administrator dashboard

The [dashboard](dashboard/README.md) is a React + TypeScript + Vite web application with Tailwind CSS + shadcn/ui, React Router, TanStack Query and Firebase Web Authentication against the NestJS administration API. Its route-level pages, role boundaries, operational workflows, accessibility checks and compiled-backend browser contract are locally implemented and validated. The dashboard is deployed at [dashboard.music-mute.com](https://dashboard.music-mute.com) from its root-shaped CapRover archive and reads its public browser configuration from CapRover variables at container startup; `.env` files are excluded. Live availability and SPA routing are verified. Authenticated production workflows still require the dashboard domain in Firebase Authentication, the dashboard origin in the API CORS allowlist, and a production backend version that exposes the administration routes. See the [D01–D14 task package](docs/tasks/full-dashboard/dashboard/README.md) and [validation record](docs/validation/full-dashboard-local.md).

## Firebase

Both native apps are registered in Firebase project `music-mute` using
`com.hatem.musicmute`. The Firebase CLI's `apps:create` and `apps:sdkconfig`
commands handle registration and configuration downloads; `firebase init` is
not needed for this native app setup.

- Android app: `1:412717301830:android:0914d9b1a4c7f4d2a9ca47`.
  Configuration: `android/app/google-services.json`. The Google Services Gradle
  plugin supplies resources and Firebase's initialization provider starts the
  default app automatically. Firebase Android BoM 34.18.0 manages Firebase Common.
- iOS app: `1:412717301830:ios:29c661efe91a5b76a9ca47`.
  Configuration: `ios/Vocal/GoogleService-Info.plist`, included in the app target.
  FirebaseCore 12.18.0 is pinned through Swift Package Manager and initialized at
  app startup. `ios/project.yml` remains the Xcode project source of truth.

The apps integrate Firebase Authentication and optional Firebase Messaging.
Messaging registration depends on notification permission and successful backend
device/session synchronization; iOS also requires APNs provisioning/token setup.
Client SDK integration does not establish live provider configuration or delivery.
YouTube downloads and original history remain local; processing storage uses the
backend's short-lived signed S3 grants.

The production Android and iOS configuration files are local-only and ignored by
Git. They contain client identifiers that are shipped in the apps and therefore
cannot be treated as secrets; restrict their API keys to the registered package,
certificate fingerprints, and bundle ID. Never force-add these files. The
emulator-only Android `authE2e` configuration is a checked-in synthetic fixture.
Do not add service-account keys, Admin SDK credentials, or CLI login tokens to the
repository.

To inspect the registrations or refresh configuration files from the repository root:

```sh
firebase apps:list --project music-mute
firebase apps:sdkconfig ANDROID 1:412717301830:android:0914d9b1a4c7f4d2a9ca47 --project music-mute --out android/app/google-services.json
firebase apps:sdkconfig IOS 1:412717301830:ios:29c661efe91a5b76a9ca47 --project music-mute --out ios/Vocal/GoogleService-Info.plist
```

Run these commands before native builds in a fresh checkout. Supply Admin SDK,
AWS, database, Redis, SMTP, and signing credentials only through ignored local
files or the deployment platform's secret/environment settings.

## Validate Android

With JDK 17 and Android SDK 36 configured:

```sh
cd android
./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest
```

## Validate iOS

Open `ios/MusicMute.xcodeproj` in Xcode. See [iOS setup and test commands](ios/README.md)
for the authorized iPhone 17 Pro simulator and the opt-in real download test.

See the backend README for local environments, verification and VPS preparation.
