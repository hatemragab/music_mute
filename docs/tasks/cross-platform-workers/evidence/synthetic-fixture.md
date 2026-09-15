# Deterministic smoke fixture

This synthetic stereo tone fixture is for decode and inference smoke tests. It is not a vocal-quality reference, representative media-class qualification, or evidence that Kim Vocal 2 produces acceptable vocal output. No third-party recording is included. W02 can materialize it using only Python's standard library.

Generated in memory and hashed on 2026-09-13:

- PCM WAV, 44100 Hz, 2 channels, signed 16-bit little-endian samples, 88200 frames.
- Byte length: `352844`.
- SHA-256: `dffe793207240b39f03c00eae05267f29548804a985c2e3179d1669a6e0e7065`.
- All waveform arithmetic is integer-only to avoid platform-specific floating-point sample differences.

Reproduction:

```python
import hashlib
import io
import struct
import wave


def triangle(frame, frequency):
    phase = ((frame * frequency) % 44100) * 4
    if phase < 44100:
        return phase
    if phase < 132300:
        return 88200 - phase
    return phase - 176400


pcm = bytearray()
for frame in range(88200):
    left = triangle(frame, 220) * 10000 // 44100
    right = triangle(frame, 330) * 8000 // 44100
    pcm.extend(struct.pack('<hh', left, right))

buffer = io.BytesIO()
with wave.open(buffer, 'wb') as output:
    output.setnchannels(2)
    output.setsampwidth(2)
    output.setframerate(44100)
    output.writeframes(bytes(pcm))

fixture = buffer.getvalue()
assert len(fixture) == 352844
assert hashlib.sha256(fixture).hexdigest() == (
    'dffe793207240b39f03c00eae05267f29548804a985c2e3179d1669a6e0e7065'
)
```

Keep a separate approved representative vocal fixture and measured reference tolerances for actual recipe promotion. Do not substitute this smoke fixture's identity for that qualification evidence.
