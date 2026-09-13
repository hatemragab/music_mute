# Synthetic media fixtures

Generate fixtures only into a new ignored artifact directory. The generator never downloads media or overwrites an existing output. FFmpeg/ffprobe are required for media generation; transport/corrupt fixtures use Python only.

```sh
python3 -m unittest discover -s tests/media-input -p 'test_generate_fixtures.py' -v
python3 tests/media-input/generate-fixtures.py --list
python3 tests/media-input/generate-fixtures.py --output artifacts/media-input/smoke
python3 tests/media-input/generate-fixtures.py --output artifacts/media-input/long \
  --fixtures audio-300s audio-900s audio-1800s duration-below duration-exact duration-above
```

`--list` produces definitions only; it does not claim that fixtures were generated or that a platform can decode them. Large transport-byte fixtures are sparse non-audio files and must never be reported as valid media. The manifest records SHA-256, actual size, stream types, and container-probed duration. Consumers must independently validate decoded presentation duration; encoder padding can differ from container duration.

`video-default-second` has distinct 440 Hz English/nondefault and 880 Hz Arabic/default soundtracks so extraction tests can identify whether the selected soundtrack was preserved. Candidate format entries marked `inspect` require actual platform evidence before being advertised as supported.

Only generated files belong under ignored `artifacts/`; do not check binaries into source or substitute real user media. Missing device/hardware evidence remains unverified.
