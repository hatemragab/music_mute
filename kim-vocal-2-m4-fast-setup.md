# Kim Vocal 2 fast setup on a Mac M4

Measured on an Apple M4 Pro with `zhama.mp3` (162.3 seconds). UVR 5 with GPU Conversion and Overlap Default finished in 9 seconds. This setup matches that: stock `audio-separator` 0.47.0, then a process-local script that runs Kim Vocal 2 as PyTorch on MPS.

The installed package is not modified. The plain `audio-separator` command still uses CoreML and is the slow path (about 19 seconds on the same song). Use the script for the speed test.

## What the script changes

1. **Model load.** At segment size 256, audio-separator 0.47.0 opens ONNX Runtime and copies every spectrogram chunk to the CPU for CoreML. The script converts `Kim_Vocal_2.onnx` with `onnx2torch`, moves it to MPS, and keeps segment size 256. That is the same choice as UVR's GPU Conversion checkbox. Do not set segment size to anything other than 256. The exported network input is `[batch, 4, 3072, 256]`.
2. **Inference.** The spectrogram stays on MPS for the forward pass. The inverse spectrogram comes back to the CPU once per chunk, which is what UVR does too.
3. **Overlap.** UVR's Overlap Default is `7680 / 261120` (about `0.029412`), from `chunk_size - n_fft`. The package default is `0.25`, which is why the CoreML run processed 38 chunks and this run processed 30.
4. **Input preparation.** MP3 and WAV go directly to the separator. Every other input format is decoded to a temporary PCM WAV, which is removed when the run ends.

| Run | Separation |
|---|---|
| UVR 5, GPU Conversion, Overlap Default | 9 seconds |
| This script, PyTorch MPS, overlap 0.029412 | 9 seconds logged, 9.9 seconds including the MP3 write |
| `audio-separator` CLI, CoreML, overlap 0.25 | 19 seconds |

`--mdx_overlap 0.029412` on the normal CLI only removes extra chunks. It stays on CoreML and does not reach 9 seconds.

## 1. System tools

```bash
brew install ffmpeg libsamplerate uv
uv python install 3.12
```

Use Python 3.12. The package rejects Python 3.14.1. The macOS system Python 3.9 is too old. `libsamplerate` is required by the pinned `samplerate` package.

## 2. Install audio-separator 0.47.0

```bash
uv tool install 'audio-separator[cpu]==0.47.0' --python 3.12 --with audioread
```

The extra is named `cpu` on an M4 too. It installs PyTorch and ONNX Runtime. `audioread` is required because 0.47.0 imports it and does not declare it.

Check:

```bash
audio-separator --version
```

Expect `audio-separator 0.47.0`.

## 3. Save the speed script

Save the following as `~/kim_mps_uvr_speed.py`. Change `SONG` and `OUT` if the song or the output folder differ on that Mac.

```python
"""Kim Vocal 2 at UVR GPU-Conversion speed: PyTorch on MPS, segment 256, UVR default overlap."""

from contextlib import ExitStack
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import torch
from audio_separator.separator import Separator
from audio_separator.separator.architectures.mdx_separator import MDXSeparator
import onnx2torch

N_FFT = 7680
HOP = 1024
SEGMENT = 256
CHUNK = HOP * (SEGMENT - 1)
UVR_DEFAULT_OVERLAP = N_FFT / CHUNK  # 0.029412, UVR "Overlap: Default"
DIRECT_INPUT_SUFFIXES = frozenset({".mp3", ".wav"})

if len(sys.argv) > 2:
    raise SystemExit("usage: kim_mps_uvr_speed.py [audio-file]")
SONG = sys.argv[1] if len(sys.argv) == 2 else "/Users/hatemragap/Downloads/test_native_youtube.webm"
OUT = "/Users/hatemragap/Documents/out"


def load_model_mps(self):
    self.uses_pytorch_inference = True
    self.model_run = onnx2torch.convert(self.model_path).to(self.torch_device).eval()
    print(
        f"pytorch mps model ready device={self.torch_device} segment={self.segment_size} dim_t={self.dim_t}",
        flush=True,
    )


def run_model_mps(self, mix, is_match_mix=False):
    spek = self.stft(mix.to(self.torch_device))
    spek[:, :, :3, :] *= 0
    if is_match_mix:
        spec_pred = spek
    elif self.enable_denoise:
        spec_pred = (self.model_run(-spek) * -0.5) + (self.model_run(spek) * 0.5)
    else:
        spec_pred = self.model_run(spek)
    if not isinstance(spec_pred, torch.Tensor):
        spec_pred = torch.as_tensor(spec_pred, device=self.torch_device)
    return self.stft.inverse(spec_pred).cpu().detach().numpy()


MDXSeparator.load_model = load_model_mps
MDXSeparator.run_model = run_model_mps

separator = Separator(
    output_dir=OUT,
    output_format="MP3",
    output_bitrate="160k",
    output_single_stem="Vocals",
    mdx_params={
        "hop_length": HOP,
        "segment_size": SEGMENT,
        "overlap": UVR_DEFAULT_OVERLAP,
        "batch_size": 1,
        "enable_denoise": False,
    },
)
started = time.perf_counter()
source = Path(SONG).expanduser().resolve(strict=True)
needs_preparation = source.suffix.lower() not in DIRECT_INPUT_SUFFIXES
with ExitStack() as cleanup:
    prepared_input = source
    if needs_preparation:
        temporary_directory = Path(
            cleanup.enter_context(tempfile.TemporaryDirectory(prefix="kim-mps-uvr-"))
        )
        prepared_input = temporary_directory / f"{source.stem}.wav"
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
                "-protocol_whitelist", "file", "-format_whitelist", "aac,flac,matroska,webm,mov,mp3,ogg,wav",
                "-i", str(source), "-map", "0:a:0", "-vn", "-c:a", "pcm_s16le",
                "-ar", "44100", "-ac", "2", str(prepared_input),
            ],
            check=True,
        )
    prepared = time.perf_counter()
    separator.load_model(model_filename="Kim_Vocal_2.onnx")
    loaded = time.perf_counter()
    outputs = separator.separate(str(prepared_input))
    separated = time.perf_counter()
finished = time.perf_counter()
print(f"separator_input={prepared_input}")
print(f"preparation_seconds={prepared - started:.2f}")
print(f"load_seconds={loaded - prepared:.2f}")
print(f"separation_seconds={separated - loaded:.2f}")
print(f"total_seconds={finished - started:.2f}")
print(f"converted_to_wav={needs_preparation}")
print(f"temporary_wav_removed={needs_preparation and not prepared_input.exists()}")
print("outputs", outputs)
```

## 4. Test

Put `test_native_youtube.webm` in `~/Downloads`, create the output folder, and run the script with the tool's Python, not Homebrew `python3`. Only `.mp3` and `.wav` inputs go directly to the separator. Every other input, including WebM, FLAC, and Ogg, is decoded first to a private, temporary 44.1 kHz stereo PCM WAV. The temporary WAV is removed after the job finishes, including when it fails. `preparation_seconds` measures the decode time:

```bash
mkdir -p ~/Documents/out
PYTORCH_ENABLE_MPS_FALLBACK=0 ~/.local/share/uv/tools/audio-separator/bin/python ~/kim_mps_uvr_speed.py
```

The first run downloads `Kim_Vocal_2.onnx` (66.8 MB) into `/tmp/audio-separator-models/`. Time the second run.

A good result on an M4:

- Log line `pytorch mps model ready device=mps segment=256 dim_t=256`
- The script prints `preparation_seconds`, `load_seconds`, `separation_seconds`, and `total_seconds` for this WebM input.
- `converted_to_wav=True` and `temporary_wav_removed=True` confirm that a non-MP3/WAV input was prepared and its temporary WAV was deleted. Both values are `False` for MP3 and WAV inputs, which are passed through unchanged.
- On success, the output is `~/Documents/out/test_native_youtube_(Vocals)_Kim_Vocal_2.mp3`.

The 9-to-11-second result above was measured with the 162.3-second `zhama.mp3`; it is not an expected duration for this 284.9-second WebM. If `device` is not `mps`, the CoreML command ran instead of this script.

On 2026-09-24, the 284.901-second `test_native_youtube.webm` completed with `preparation_seconds=0.50`, `load_seconds=0.22`, `separation_seconds=17.28`, and `total_seconds=18.00` on the M4 Pro, with the installed worker stopped during measurement. The output was a 44.1 kHz stereo, 160 kbps MP3. This is a local script measurement; a separate worker job on the same-duration audio recorded 44.051 seconds in its broader separation stage, and that difference has not yet been explained.

## 5. Compare source formats

Run `tools/prepare_uvr_audio_formats.py` with the audio-separator Python environment to create PCM WAV, FLAC, 160 kbps MP3, and Ogg Opus in `~/Downloads/out_diffrent_formats`. It records each FFmpeg wall time and file size in `ffmpeg_format_timings.json`. Ogg Opus copies the original encoded audio into a supported container without re-encoding. Its `soundfile` and `librosa` compatibility check is informational; this speed script still converts FLAC and Ogg to WAV before separation.

```bash
~/.local/share/uv/tools/audio-separator/bin/python tools/prepare_uvr_audio_formats.py
PYTORCH_ENABLE_MPS_FALLBACK=0 ~/.local/share/uv/tools/audio-separator/bin/python ~/kim_mps_uvr_speed.py ~/Downloads/out_diffrent_formats/test_native_youtube_opus_ogg_copy.ogg
```

The speed script accepts any of the prepared file paths as its optional argument. WAV and MP3 go directly to the separator, so `preparation_seconds` is near zero for those runs. FLAC and Ogg are converted to a temporary WAV first; their `preparation_seconds` includes that conversion, and the WAV is deleted after the run. Give each format a separate run while the installed worker is drained and stopped to avoid GPU contention, then restart and resume the worker.
