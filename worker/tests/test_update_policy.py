import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from musicmute_worker.update.policy import ArtifactCache, ControlClient, parse_decision

NOW = "2027-01-15T08:00:00.000Z"


def policy():
    return {
        "serverTime": NOW,
        "policyRevision": 1,
        "action": "none",
        "target": None,
        "minimumClaimBuild": 1,
        "allowedFallbackReleaseIds": [],
        "reasonCodes": [],
    }


class PolicyTests(unittest.TestCase):
    def test_control_client_exact_scopes_and_clock(self):
        identity = str(uuid4())
        requests = []

        def http(request, timeout):
            requests.append(request)
            data = (
                policy()
                if request.full_url.endswith("update-policy")
                else {
                    "serverTime": NOW,
                    "acceptedEventIds": [],
                    "duplicateEventIds": [],
                }
            )
            response = io.BytesIO(json.dumps(data).encode())
            response.status = 200
            return response

        for setup in (True, False):
            client = ControlClient(
                "https://api.example.test/api/v1",
                identity,
                "synthetic-test-bearer",
                setup=setup,
                http_open=http,
            )
            self.assertEqual(client.server_time(), NOW)
            client.post_events([])
            self.assertEqual(
                requests[-1].full_url,
                "https://api.example.test/api/v1/"
                + (
                    f"worker-installations/{identity}/events"
                    if setup
                    else "worker/events"
                ),
            )
        self.assertTrue(
            all(
                r.headers["Authorization"] == "Bearer synthetic-test-bearer"
                for r in requests
            )
        )

    def test_policy_rejects_unknowns_and_missing_clock(self):
        for mutate in (
            lambda p: p.pop("serverTime"),
            lambda p: p.update(untrusted="yes"),
            lambda p: p.update(action="prepare"),
            lambda p: p.update(policyRevision=True),
        ):
            value = policy()
            mutate(value)
            with self.assertRaises(ValueError):
                parse_decision(value)

    def test_cache_preserves_active_prepared_and_permitted_rollback(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root).resolve()
            cache = ArtifactCache(root)
            for digest in ("1" * 64, "2" * 64, "3" * 64, "4" * 64):
                (root / digest).write_text("cached")
            self.assertEqual(cache.prune(), [])
            records = [
                {"releaseId": str(uuid4()), "assets": [str(n) * 64]} for n in (1, 2, 3)
            ]
            cache.retain(
                active=records[0],
                prepared=records[1],
                rollback=[records[2]],
                allowed_fallback_ids=[records[2]["releaseId"]],
            )
            self.assertEqual(cache.prune(), ["4" * 64])
            self.assertTrue(all((root / (str(n) * 64)).exists() for n in (1, 2, 3)))
            with self.assertRaises(ValueError):
                cache.retain(
                    active=records[0],
                    prepared=None,
                    rollback=[records[2]],
                    allowed_fallback_ids=[],
                )

    def test_policy_reporting_and_launcher_import_with_broken_gpu_environment(self):
        program = r"""
import sys, importlib.abc, io, json, tempfile
from pathlib import Path
from uuid import uuid4
class BrokenGPU(importlib.abc.MetaPathFinder):
 def find_spec(self, fullname, path=None, target=None):
  if fullname.split('.')[0] in ('onnxruntime','torch','numpy','soundfile'):
   raise ImportError('deliberately broken separation dependency')
sys.meta_path.insert(0,BrokenGPU())
try: import onnxruntime
except ImportError: pass
else: raise AssertionError('GPU environment must be broken')
from musicmute_worker.launcher import Launcher
from musicmute_worker.events import EventSpool
from musicmute_worker.update.policy import ControlClient
from musicmute_worker.update.trust import ReleaseVerifier
from datetime import datetime,timezone
now=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def http(request,timeout):
 data={'serverTime':now,'policyRevision':1,'action':'none','target':None,'minimumClaimBuild':1,'allowedFallbackReleaseIds':[],'reasonCodes':[]}
 if request.data:
  body=json.loads(request.data); data={'serverTime':now,'acceptedEventIds':[e['eventId'] for e in body['events']],'duplicateEventIds':[]}
 response=io.BytesIO(json.dumps(data).encode()); response.status=200; return response
identity=str(uuid4()); client=ControlClient('https://api.example.test/api/v1',identity,'synthetic',http_open=http)
assert client.fetch_policy()['action']=='none'
with tempfile.TemporaryDirectory() as root:
 spool=EventSpool(Path(root).resolve(),identity)
 spool.append({'eventId':str(uuid4()),'operationId':str(uuid4()),'sequence':1,'category':'startup','stage':'startup','status':'failed','occurredAt':now,'code':'GPU_PROVIDER_UNAVAILABLE'})
 assert len(spool.upload_pending(client)['acceptedEventIds'])==1
assert not any(n in sys.modules for n in ('onnxruntime','torch','numpy','soundfile'))
print('independent policy and reporting passed')
"""
        result = subprocess.run(
            [sys.executable, "-c", program], capture_output=True, text=True, check=False
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("independent policy and reporting passed", result.stdout)


class LauncherMaintenanceTests(unittest.TestCase):
    def test_factory_binds_api_identity_and_separate_private_roots(self):
        from musicmute_worker.launcher import InstallationBinding, Launcher
        from test_launcher import AdapterFixture
        from worker_test_support import config

        with tempfile.TemporaryDirectory() as root:
            root = Path(root).resolve()
            configuration = config(
                "https://api.example.test/api/v1",
                root / "journals",
                root / "separator.py",
            )
            binding = InstallationBinding.load(
                configuration.paths.identity / "installation.json"
            )
            adapter = AdapterFixture(root / "lock", binding)
            launcher = Launcher(configuration.paths, adapter)
            client = ControlClient(
                binding.api_base_url, binding.installation_id, "synthetic"
            )
            services = launcher.maintenance(
                client,
                bootstrap_root=b"provided bootstrap bytes",
                distribution_origin="https://updates.example.test",
            )
            self.assertEqual(
                services["events"].installation_id, binding.installation_id
            )
            self.assertEqual(
                services["cache"].root, configuration.paths.state / "update-artifacts"
            )
            self.assertFalse((configuration.paths.journals / "events.sqlite3").exists())
            other = ControlClient(
                "https://other.example.test/api/v1",
                binding.installation_id,
                "synthetic",
            )
            with self.assertRaises(ValueError):
                launcher.maintenance(
                    other,
                    bootstrap_root=b"root",
                    distribution_origin="https://updates.example.test",
                )
