import unittest
import tempfile
from pathlib import Path
from unittest.mock import Mock

try:
    import numpy as np
except ImportError:
    np = None

from musicmute_worker.separation import KimSpectrogram, KimSeparator


@unittest.skipIf(np is None, "requires isolated numerical runtime")
class KimDSPTests(unittest.TestCase):
    def test_vocal_flac_preserves_upstream_pydub_pcm16_truncation(self):
        import soundfile as sf

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.wav"
            sf.write(
                source,
                np.full((100, 2), 0.5, dtype=np.float32),
                44100,
                subtype="PCM_16",
            )
            waveform = np.tile(
                np.array([[0.12345], [-0.23456]], dtype=np.float32), (1, 100)
            )
            separator = KimSeparator(None, root / "stems", 2)
            separator.demix = Mock(return_value=waveform.copy())
            names = separator.separate(source)
            actual, _ = sf.read(
                root / "stems" / names[0], dtype="int16", always_2d=True
            )
            expected = (waveform.T * 0.5 * 32767).astype(np.int16)
            np.testing.assert_array_equal(actual, expected)

    def test_shape_finite_and_band_limited_round_trip(self):
        dsp = KimSpectrogram()
        t = np.arange(261120, dtype=np.float64) / 44100
        audio = np.stack([np.sin(t * 440 * 2 * np.pi), np.cos(t * 660 * 2 * np.pi)])[
            None
        ].astype(np.float32)
        spectrum = dsp.forward(audio)
        self.assertEqual(spectrum.shape, (1, 4, 3072, 256))
        result = dsp.inverse(spectrum)
        self.assertEqual(result.shape, audio.shape)
        self.assertTrue(np.isfinite(result).all())
        self.assertLess(
            float(np.max(np.abs(result[..., 7680:-7680] - audio[..., 7680:-7680]))),
            1e-4,
        )

    def test_nonfinite_spectrum_is_rejected(self):
        with self.assertRaises(ValueError):
            KimSpectrogram().inverse(
                np.full((1, 4, 3072, 256), np.nan, dtype=np.float32)
            )
