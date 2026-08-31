# Vocal Remover Mobile

Flutter Android client for the Vocal Remover Cloud Run service.

## Prerequisites

- Flutter 3.x (Dart 3)
- Android SDK / emulator or device

## Setup

```bash
flutter pub get
```

## Run

```bash
flutter run
```

On first launch, open **Settings** and set the backend URL to your Cloud Run service URL (`https://<CLOUD_RUN_URL>`).

## Build APK

```bash
flutter build apk --release
# output: build/app/outputs/flutter-apk/app-release.apk
```

## Analyze / Format / Test

```bash
flutter analyze
dart format .
flutter test
```
