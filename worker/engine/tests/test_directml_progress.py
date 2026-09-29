from __future__ import annotations

import logging
import unittest
from types import MethodType
from unittest.mock import patch

import numpy as np
from audio_separator.separator.architectures.mdx_separator import MDXSeparator

from musicmute_engine.separator import _instrument_directml_progress, SeparatorError


class DirectMLProgressTests(unittest.TestCase):
    def model(self):
        # Exercise the pinned upstream windowing implementation with an identity
        # inference function. No model download or GPU is needed for this check.
        model = object.__new__(MDXSeparator)
        model.logger = logging.getLogger(__name__)
        model.torch_device = "cpu"
        model.overlap = 0.25
        model.batch_size = 1
        model.hop_length = 4
        model.segment_size = 5

        def initialize(instance):
            instance.chunk_size = 16
            instance.trim = 2

        def run(_instance, window, is_match_mix=False):
            return window.cpu().numpy().copy()

        model.initialize_model_settings = MethodType(initialize, model)
        model.run_model = MethodType(run, model)
        return model

    def test_progress_preserves_upstream_output_at_window_boundaries(self):
        for length in (1, 11, 12, 13, 24, 53):
            with self.subTest(length=length):
                mix = np.arange(2 * length, dtype=np.float32).reshape(2, length)
                reference = self.model()
                candidate = self.model()
                events = []
                candidate.on_window_progress = lambda done, total: events.append((done, total))
                _instrument_directml_progress(candidate)
                with patch("audio_separator.separator.architectures.mdx_separator.tqdm", lambda values: values), np.errstate(invalid="ignore"):
                    expected = reference.demix(mix)
                    actual = candidate.demix(mix)
                np.testing.assert_array_equal(actual, expected)
                self.assertTrue(np.isfinite(actual).all())
                self.assertEqual(actual.shape, mix.shape)
                count = candidate.grouped_windows
                self.assertEqual(events, [(index, count) for index in range(1, count + 1)])
                self.assertEqual(candidate.grouped_model_calls, count)
                self.assertEqual(candidate.grouped_max_batch, 1)

    def test_warmup_is_not_reported_as_file_progress(self):
        import torch

        model = self.model()
        events = []
        model.on_window_progress = lambda *event: events.append(event)
        _instrument_directml_progress(model)
        model.run_model(torch.zeros((1, 2, 16)))
        self.assertEqual(events, [])

    def test_changed_upstream_window_count_fails_closed(self):
        model = self.model()
        model.demix = lambda mix, is_match_mix=False: mix
        _instrument_directml_progress(model)
        with self.assertRaisesRegex(SeparatorError, "window count changed"):
            model.demix(np.zeros((2, 53), dtype=np.float32))

    def test_failure_does_not_leave_progress_active(self):
        import torch

        model = self.model()
        events = []

        def fail(_mix, is_match_mix=False):
            raise RuntimeError("inference failed")

        model.demix = fail
        model.on_window_progress = lambda *event: events.append(event)
        _instrument_directml_progress(model)
        with self.assertRaisesRegex(RuntimeError, "inference failed"):
            model.demix(np.zeros((2, 53), dtype=np.float32))
        model.run_model(torch.zeros((1, 2, 16)))
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
