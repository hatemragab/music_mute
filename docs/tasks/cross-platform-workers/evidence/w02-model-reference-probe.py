import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
import numpy as np

ROOT = Path('/Users/hatemragap/work_spaces/music_remover')
MODEL = Path('/tmp/musicmute-w02-cache/ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b-Kim_Vocal_2.onnx')
DATA = Path('/tmp/musicmute-w02-model-reference-data.npz')
source = ROOT / 'worker/musicmute_worker/separation.py'
source_before = hashlib.sha256(source.read_bytes()).hexdigest()
assert MODEL.stat().st_size == 66759214
assert hashlib.sha256(MODEL.read_bytes()).hexdigest() == 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b'
sys.path.insert(0, str(ROOT / 'worker'))

if '--gpu' in sys.argv:
    from musicmute_worker.separation import gpu_session, KimSeparator
    session = gpu_session(MODEL, 'CoreMLExecutionProvider', {
        'ModelFormat': 'MLProgram', 'MLComputeUnits': 'CPUAndGPU',
        'RequireStaticInputShapes': '1', 'EnableOnSubgraphs': '0', 'ProfileComputePlan': '1',
    }, Path('/tmp/musicmute-w02-reference-gpu'))
    with np.load(DATA, allow_pickle=False) as archive:
        mix = archive['mix']
        expected = archive['expected']
    actual = KimSeparator(session, Path('/tmp/musicmute-w02-reference-output'), 30).demix(mix.copy())
    delta = actual.astype(np.float64) - expected.astype(np.float64)
    expected_rms = float(np.sqrt(np.mean(expected.astype(np.float64)**2)))
    error_rms = float(np.sqrt(np.mean(delta**2)))
    result = {'comparison': 'upstream Torch DSP + explicit CPU ORT reference versus new NumPy DSP + verified CoreML GPU',
              'samples': mix.shape[-1], 'expected_rms': expected_rms, 'error_rms': error_rms,
              'relative_l2': error_rms / max(expected_rms, 1e-12), 'max_abs': float(np.abs(delta).max()),
              'all_finite': bool(np.isfinite(actual).all() and np.isfinite(expected).all()),
              'source_sha256_before': source_before, 'source_sha256_after': hashlib.sha256(source.read_bytes()).hexdigest(),
              'runtime_python': sys.version.split()[0], 'actual_shape': list(actual.shape)}
    print(json.dumps(result, indent=2), flush=True)
    assert result['all_finite']
    assert result['relative_l2'] <= 0.001 and result['max_abs'] <= 0.001, result
    assert result['source_sha256_before'] == result['source_sha256_after']
else:
    import ast
    import logging
    import torch
    import onnxruntime as ort
    torch.set_num_threads(2)
    def upstream_class(path, name, methods=None):
        cls = next(n for n in ast.parse(Path(path).read_text()).body if isinstance(n, ast.ClassDef) and n.name == name)
        cls.bases = []
        if methods:
            cls.body = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in methods]
        namespace = {'np': np, 'torch': torch, 'tqdm': lambda x: x,
                     'should_fallback_to_cpu_for_complex_ops': lambda d: False}
        if name == 'MDXSeparator': namespace['STFT'] = STFT
        exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])), path, 'exec'), namespace)
        return namespace[name]
    STFT = upstream_class('/tmp/musicmute-w02-stft.py', 'STFT')
    MDX = upstream_class('/tmp/musicmute-w02-mdx.py', 'MDXSeparator', {'initialize_model_settings','demix','run_model'})
    settings = ort.SessionOptions()
    settings.intra_op_num_threads = 2
    settings.inter_op_num_threads = 1
    settings.add_free_dimension_override_by_name('batch_size', 1)
    # CPU execution is confined to this labelled numerical reference, never product admission.
    reference_session = ort.InferenceSession(str(MODEL), sess_options=settings, providers=['CPUExecutionProvider'])
    upstream = MDX()
    logger = logging.getLogger('reference')
    logger.setLevel(logging.CRITICAL)
    for key, value in {'logger': logger, 'n_fft': 7680, 'hop_length': 1024,
                       'segment_size': 256, 'dim_f': 3072, 'torch_device': torch.device('cpu'),
                       'overlap': 0.25, 'batch_size': 1, 'enable_denoise': False}.items():
        setattr(upstream, key, value)
    upstream.model_run = lambda x: reference_session.run(None, {'input': x.cpu().numpy()})[0]
    t = np.arange(88200, dtype=np.float64) / 44100
    mix = np.stack([0.16*np.sin(2*np.pi*220*t)+0.09*np.sin(2*np.pi*440*t)+0.03*np.cos(2*np.pi*3100*t),
                    0.12*np.sin(2*np.pi*330*t)+0.08*np.sin(2*np.pi*660*t)+0.02*np.cos(2*np.pi*1900*t)]).astype(np.float32)
    mix += np.random.default_rng(173).uniform(-0.015,0.015,mix.shape).astype(np.float32)
    with np.errstate(invalid='ignore', divide='ignore'):
        expected = upstream.demix(mix.copy())
    np.savez(DATA, mix=mix, expected=expected)
    result = subprocess.run(['/tmp/musicmute-w02-prepared/venv/bin/python', __file__, '--gpu'], check=False, timeout=90)
    assert source_before == hashlib.sha256(source.read_bytes()).hexdigest(), 'Source changed during full comparison'
    raise SystemExit(result.returncode)
