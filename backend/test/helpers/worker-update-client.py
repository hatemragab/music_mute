"""Actual control client with a confined isolated HTTP test transport."""

import hashlib
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "worker"))
from musicmute_worker.events import EventRequestError
from musicmute_worker.update.policy import ControlClient

settings = json.load(sys.stdin)
local = urlsplit(settings["localOrigin"])
assert local.scheme == "http" and local.hostname == "127.0.0.1" and local.port
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
payload_hashes = []


def isolated_open(request, timeout):
    parsed = urlsplit(request.full_url)
    assert parsed.scheme == "https" and parsed.netloc == "update.fixture.invalid"
    assert parsed.path in (
        "/api/v1/worker/update-policy",
        "/api/v1/worker/update-status",
    )
    assert not parsed.query
    mapped = urllib.request.Request(
        settings["localOrigin"] + parsed.path,
        data=request.data,
        headers=dict(request.header_items()),
        method=request.get_method(),
    )
    is_status = request.get_method() == "POST"
    if is_status:
        payload_hashes.append(hashlib.sha256(request.data).hexdigest())
    response = http.open(mapped, timeout=timeout)
    if is_status and settings.get("loseResponse"):
        response.read()
        response.close()
        raise urllib.error.URLError("simulated loss after status acceptance")
    return response


client = ControlClient(
    "https://update.fixture.invalid/api/v1",
    settings["installationId"],
    settings["bearer"],
    http_open=isolated_open,
)
try:
    policy = client.fetch_policy()
except EventRequestError as error:
    print(json.dumps({"errorStatus": error.status, "retryAfter": error.retry_after}))
    sys.exit(0)
result = {"action": policy["action"], "policyRevision": policy["policyRevision"]}
try:
    result["receipt"] = client.post_update_status(settings["payload"])
except EventRequestError as error:
    result["errorStatus"] = error.status
except OSError:
    result["lostResponse"] = True
result["payloadHashes"] = payload_hashes
print(json.dumps(result))
