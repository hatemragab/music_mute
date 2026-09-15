"""Isolated HTTP integration adapter; product clients remain HTTPS-only."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "worker"))
from musicmute_worker.events import EventSpool, utc_string
from musicmute_worker.update.policy import ControlClient

settings = json.load(sys.stdin)
local = urlsplit(settings["localOrigin"])
assert local.scheme == "http" and local.hostname == "127.0.0.1" and local.port
payload_hashes = []
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def isolated_open(request, timeout):
    parsed = urlsplit(request.full_url)
    assert parsed.scheme == "https" and parsed.netloc == "spool.fixture.invalid"
    assert parsed.path.startswith("/api/v1/") and not parsed.query
    mapped = urllib.request.Request(
        settings["localOrigin"] + parsed.path,
        data=request.data,
        headers=dict(request.header_items()),
        method=request.get_method(),
    )
    is_event = parsed.path.endswith("/events")
    if is_event:
        payload_hashes.append(hashlib.sha256(request.data).hexdigest())
    response = http.open(mapped, timeout=timeout)
    if is_event and settings["phase"] == "lost-response":
        response.read()
        response.close()
        raise urllib.error.URLError("simulated loss after backend acceptance")
    return response


clock = lambda: time.time() + settings["clockSkew"]
spool = EventSpool(Path(settings["spoolRoot"]), settings["installationId"], clock=clock)
if settings["phase"] == "lost-response":
    spool.append(
        {
            "eventId": settings["eventId"],
            "operationId": settings["operationId"],
            "sequence": 1,
            "category": "installation",
            "stage": "download",
            "status": "failed",
            "code": "DOWNLOAD_FAILED",
            "occurredAt": utc_string(clock() - 1),
            "details": {
                "component": "runtime",
                "diagnostic": "Bearer fixture-private-do-not-store",
            },
        }
    )
client = ControlClient(
    "https://spool.fixture.invalid/api/v1",
    settings["installationId"],
    settings["bearer"],
    setup=settings["phase"] == "lost-response",
    http_open=isolated_open,
)
receipt = spool.upload_pending(client)
print(
    json.dumps(
        {
            "receipt": receipt,
            "state": spool.inspect(),
            "payloadHashes": payload_hashes,
            "gpuDependenciesAbsent": all(
                importlib.util.find_spec(name) is None
                for name in ("onnxruntime", "torch", "numpy")
            ),
        }
    )
)
