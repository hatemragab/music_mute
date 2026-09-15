import ast
import hashlib
import json
import logging
import sys
from pathlib import Path

import numpy as np
import torch

torch.set_num_threads(2)
root = Path('/Users/hatemragap/work_spaces/music_remover')
source_path = root / 'worker/musicmute_worker/separation.py'
source_before = hashlib.sha256(source_path.read_bytes()).hexdigest()
sys.path.insert(0, str(root / 'worker'))
from musicmute_worker.separation import KimSpectrogram, KimSeparator

def load_class(path, name, methods=None):
    tree = ast.parse(Path(path).read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == name)
    cls.bases = []
    if methods is not None:
        cls.body = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in methods]
    namespace = {'np': np, 'torch': torch, 'tqdm': lambda x: x,
                 'should_fallback_to_cpu_for_complex_ops': lambda device: False}
    if name == 'MDXSeparator':
        namespace['STFT'] = UpstreamSTFT
    exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])), path, 'exec'), namespace)
    return namespace[name]

UpstreamSTFT = load_class('/tmp/musicmute-w02-stft.py', 'STFT')
UpstreamMDX = load_class('/tmp/musicmute-w02-mdx.py', 'MDXSeparator', {'initialize_model_settings', 'demix', 'run_model'})
logger = logging.getLogger('reference')
logger.addHandler(logging.NullHandler())
logger.setLevel(logging.CRITICAL)
reference = UpstreamSTFT(logger, 7680, 1024, 3072, torch.device('cpu'))
actual = KimSpectrogram()

def metrics(a, b):
    diff = a.astype(np.float64) - b.astype(np.float64)
    return {'shape': list(a.shape), 'max_abs': float(np.max(np.abs(diff))),
            'rms': float(np.sqrt(np.mean(diff * diff))), 'finite': bool(np.isfinite(a).all() and np.isfinite(b).all())}

def audio(length, kind):
    if kind == 'zero':
        return np.zeros((2, length), np.float32)
    if kind == 'impulse':
        x = np.zeros((2, length), np.float32)
        x[0, min(7, length - 1)] = 0.7
        x[1, max(0, length - 8)] = -0.7
        return x
    if kind == 'noise':
        return np.random.default_rng(927).uniform(-0.3, 0.3, (2, length)).astype(np.float32)
    t = np.arange(length, dtype=np.float64) / 44100
    return np.stack([0.2*np.sin(2*np.pi*440*t)+0.05*np.sin(2*np.pi*18000*t),
                     0.15*np.sin(2*np.pi*1200*t)+0.04*np.cos(2*np.pi*25*t)]).astype(np.float32)

results = {'torch': torch.__version__, 'numpy': np.__version__, 'stft': [], 'demix': []}
for kind in ['zero', 'impulse', 'noise', 'tones']:
    x = audio(actual.chunk, kind)[None]
    a = actual.forward(x)
    b = reference(torch.from_numpy(x)).numpy()
    forward = metrics(a, b)
    inverse = metrics(actual.inverse(b), reference.inverse(torch.from_numpy(b)).numpy())
    results['stft'].append({'case': kind, 'forward': forward, 'inverse': inverse})
    assert np.allclose(a, b, atol=0.0002, rtol=0.00002), forward
    assert inverse['max_abs'] < 0.000002 and inverse['finite'], inverse

def model_op(x, mode):
    if mode == 'identity':
        return x.copy()
    return (x * np.float32(0.73) / (np.float32(1) + np.float32(0.002) * np.abs(x))).astype(np.float32)

class FakeSession:
    def __init__(self, mode): self.mode = mode
    def run(self, _, inputs): return [model_op(inputs['input'], self.mode)]

for mode in ['identity', 'nonlinear']:
    upstream = UpstreamMDX()
    for key, value in {'logger': logger, 'n_fft': 7680, 'hop_length': 1024,
                       'segment_size': 256, 'dim_f': 3072, 'torch_device': torch.device('cpu'),
                       'overlap': 0.25, 'batch_size': 1, 'enable_denoise': False}.items():
        setattr(upstream, key, value)
    upstream.model_run = lambda x, mode=mode: model_op(x.cpu().numpy(), mode)
    ours = KimSeparator(FakeSession(mode), Path('/tmp/musicmute-reference-unused'), 30)
    for length, kind in [(1,'impulse'), (44100,'tones'), (253440,'noise'),
                         (261119,'impulse'), (261120,'tones'), (261121,'noise'),
                         (522247,'tones')]:
        x = audio(length, kind)
        with np.errstate(invalid='ignore', divide='ignore'):
            expected = upstream.demix(x.copy())
        observed = ours.demix(x.copy())
        m = metrics(observed, expected)
        results['demix'].append({'mode': mode, 'samples': length, 'case': kind, **m})
        assert m['finite'] and m['max_abs'] < 0.000003, m

results['source_sha256_before'] = source_before
results['source_sha256_after'] = hashlib.sha256(source_path.read_bytes()).hexdigest()
results['upstream_hashes'] = {p: hashlib.sha256(Path('/tmp/'+p).read_bytes()).hexdigest()
                              for p in ['musicmute-w02-stft.py', 'musicmute-w02-mdx.py']}
print(json.dumps(results, indent=2))
assert results['source_sha256_before'] == results['source_sha256_after'], 'Source changed during reference probe'
