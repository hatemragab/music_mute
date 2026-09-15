"""Offline candidate diagnostic; never requests admission or claims qualification."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
from uuid import uuid4

REPO = Path('/Users/hatemragap/work_spaces/music_remover')
sys.path[:0] = [str(REPO / 'worker'), str(REPO / 'worker/tests')]
from musicmute_worker.profiles import Profile, PreparedRuntime, digest_file, smoke_fixture
from musicmute_worker.processes import ProcessRunner
from musicmute_worker.qualification import execution_evidence
from musicmute_worker.worker import Worker
from worker_test_support import config

runtime_root = Path('/private/tmp/musicmute-w02-round1-prepared')
profile_path = REPO / 'worker/profiles/macos-arm64-coreml.candidate.json'
profile = Profile.load(profile_path, digest_file(profile_path))
assert profile.status == 'candidate'
model = Path('/tmp/musicmute-w02-cache') / (profile.model.sha256 + '-Kim_Vocal_2.onnx')
runtime = PreparedRuntime(
    python=runtime_root / 'venv/bin/python', profile=profile, model=model,
    ffmpeg=runtime_root / 'ffmpeg', ffprobe=runtime_root / 'ffprobe', root=runtime_root,
    versions={}, runtime_inventory=json.loads(Path('/tmp/musicmute-w02-round1-inventory.json').read_text()),
)
separator = REPO / 'worker/musicmute_worker/separation.py'
source_hashes = {p.name: digest_file(p) for p in separator.parent.glob('*.py')}
work = Path(tempfile.mkdtemp(prefix='musicmute-worker-path-diagnostic-'))
source = work / 'fixture.wav'
source.write_bytes(smoke_fixture())
calls = []

class LocalApi:
    def post(self, route, body):
        assert route == 'stage', 'No admission, claims or external requests allowed'
        calls.append(route)
        return {'status': 'processing'}

class LocalTransfers:
    def download(self, grant, path, size, checksum, check):
        check()
        shutil.copyfile(source, path)
    def upload(self, *args):
        raise AssertionError('Diagnostic never uploads')

class LocalLease:
    def check(self, **kwargs):
        return None

class DiagnosticGpuEngine:
    """Only replaces engine transport with supported candidate qualification mode."""
    def run(self, prepared, output, *, timeout, check):
        diagnostic = work / 'gpu'
        diagnostic.mkdir()
        request = {
            'model': str(model), 'modelSha256': profile.model.sha256,
            'provider': profile.provider, 'options': profile.options,
            'input': str(prepared), 'ffmpeg': str(runtime.ffmpeg),
            'output': str(diagnostic / 'vocals.wav'), 'reference': None,
            'maxDurationSeconds': profile.max_duration_seconds,
            'maxRamBytes': profile.max_ram_bytes,
            'referenceMaxAbs': profile.reference_max_abs,
            'referenceRms': profile.reference_rms,
        }
        request_path = diagnostic / 'request.json'
        request_path.write_text(json.dumps(request))
        ProcessRunner().run(
            [str(runtime.python), '-I', '-B', str(separator), '--qualify', str(request_path)],
            cwd=diagnostic, timeout=min(timeout, profile.max_wall_seconds), check=check,
            capture=True,
        )
        report = json.loads((diagnostic / 'result.json').read_text())
        assert report['outputValid'] and not report['referenceCheckPassed']
        self.observation = execution_evidence(
            json.loads((diagnostic / 'profile.json').read_text()), profile.provider,
            (diagnostic / 'placement.log').read_text(),
        )
        output.mkdir(parents=True, exist_ok=True)
        files = list((diagnostic / 'encoded').glob('*.mp3'))
        assert len(files) == 1
        shutil.copyfile(files[0], output / files[0].name)
    def close(self):
        return None

assignment = {
    'jobId': 'a' * 24, 'attemptId': str(uuid4()), 'sessionId': str(uuid4()),
    'generation': 1, 'status': 'validating',
    'input': {'extension': 'wav', 'bytes': source.stat().st_size,
              'sha256': base64.b64encode(hashlib.sha256(source.read_bytes()).digest()).decode(),
              'durationSeconds': 2, 'download': {'url': 'https://fixture.invalid/not-requested'}},
}
configuration = config('https://fixture.invalid/api/v1', work / 'state', separator)
worker = Worker(configuration, LocalApi(), LocalTransfers(), runtime=runtime)
worker.progress.bind(assignment)
worker.execution.bind(assignment['attemptId'])
engine = DiagnosticGpuEngine()
worker._engine = engine
worker._engine_fingerprint = worker.progress.processor_fingerprint
os.environ['PATH'] = '/nonexistent'
started = time.monotonic()
try:
    result = worker._result(assignment, LocalLease(), ProcessRunner())
    assert calls == ['stage']
    assert worker.progress.data['prepared'] and worker.progress.data['output']
    assert runtime.profile.status == 'candidate' and runtime.qualification_report is None
    unchanged = source_hashes == {p.name: digest_file(p) for p in separator.parent.glob('*.py')}
    print(json.dumps({'passed': True, 'wallSeconds': time.monotonic()-started,
        'preparedDuration': worker.progress.data['inputDurationSeconds'],
        'outputDuration': worker.progress.data['output']['durationSeconds'],
        'outputBytes': result.stat().st_size, 'outputSha256': digest_file(result),
        'gpuEvidence': engine.observation, 'sourceUnchanged': unchanged,
        'candidateStatusPreserved': True, 'productAdmissionTested': False,
        'diagnosticEngineAdapter': True, 'work': str(work)}, indent=2))
finally:
    worker.close()
