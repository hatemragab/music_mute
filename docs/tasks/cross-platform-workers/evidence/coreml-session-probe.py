import hashlib
import json
import time
import urllib.request
from collections import Counter

import numpy as np
import onnx
import onnxruntime as ort

url = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx'
with urllib.request.urlopen(url, timeout=60) as response:
    payload = response.read(66759215)
assert len(payload) == 66759214
assert hashlib.sha256(payload).hexdigest() == 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b'
model = onnx.load_model_from_string(payload)
onnx.checker.check_model(model, full_check=True)
print('MODEL_CHECK_OK', flush=True)
for item in model.graph.input:
    print('INPUT', item.name, [d.dim_value or d.dim_param for d in item.type.tensor_type.shape.dim], flush=True)
options = ort.SessionOptions()
options.add_session_config_entry('session.disable_cpu_ep_fallback', '1')
options.add_free_dimension_override_by_name('batch_size', 1)
options.enable_profiling = True
options.profile_file_prefix = '/tmp/musicmute-f01-coreml-profile'
options.log_severity_level = 0
options.log_verbosity_level = 1
started = time.monotonic()
session = ort.InferenceSession(payload, sess_options=options, providers=[('CoreMLExecutionProvider', {
    'ModelFormat': 'MLProgram',
    'MLComputeUnits': 'CPUAndGPU',
    'RequireStaticInputShapes': '1',
    'EnableOnSubgraphs': '0',
    'ProfileComputePlan': '1',
})])
session.disable_fallback()
print('SESSION_OK', round(time.monotonic() - started, 3), session.get_providers(), flush=True)
inputs = {}
for item in session.get_inputs():
    shape = [d if isinstance(d, int) and d > 0 else 1 for d in item.shape]
    assert len(shape) == 4 and shape[1:] == [4, 3072, 256], shape
    inputs[item.name] = np.zeros(shape, dtype=np.float32)
started = time.monotonic()
outputs = session.run(None, inputs)
print('RUN_OK', round(time.monotonic() - started, 3), [{'shape': list(x.shape), 'finite': bool(np.isfinite(x).all())} for x in outputs], flush=True)
profile = session.end_profiling()
with open(profile) as source:
    events = json.load(source)
print('PROFILE_PROVIDERS', dict(Counter(e.get('args', {}).get('provider') for e in events if e.get('args', {}).get('provider'))), flush=True)
assert not any(e.get('args', {}).get('provider') == 'CPUExecutionProvider' for e in events)
print('PROFILE_PATH', profile, flush=True)
