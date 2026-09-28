"""Opt-in single live task inside adapter container; safe stage output only."""
import json
import os
import tempfile
import time
from service import Provider, Failure

started = time.monotonic()
def check():
    if time.monotonic() - started > 120:
        raise Failure()

class DiagnosticProvider(Provider):
    def request(self, path, body=None):
        route = '/'.join(path.split('?')[0].split('/')[:3])
        try:
            result = super().request(path, body)
        except Failure as error:
            print(json.dumps({'route': route, 'code': error.code}), flush=True)
            raise
        print(json.dumps({'route': route, 'kind': type(result).__name__,
                          'format_count': len(result) if isinstance(result, list) else None,
                          'status': result.get('status') if isinstance(result, dict) else None,
                          'keys': sorted(result.keys()) if isinstance(result, dict) else None}), flush=True)
        return result

try:
    with tempfile.TemporaryFile(dir='/work') as output:
        size, extra = DiagnosticProvider(os.environ['VIDEOSCALE_BASIC_AUTH'], check).acquire(
            'https://www.youtube.com/watch?v=aqz-KE-bpKQ', 50_000_000, output)
        print(json.dumps({'bytes': size, 'metadata': extra}), flush=True)
except Exception as error:
    print(json.dumps({'failed': True, 'type': type(error).__name__,
                      'code': error.code if isinstance(error, Failure) else 'UNEXPECTED'}), flush=True)
    raise SystemExit(1)
