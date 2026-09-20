# Z440 / RX 580 testing through SSH

## Prerequisites and boundaries

The owner will supply the SSH host, port, username, approved authentication and verified host fingerprint later. No actual connection was made during package preparation. Until these are supplied, implementation agents may write/test fixtures but must leave real Windows checks `NOT_RUN`.

The Windows machine is the owner's Z440 with RX 580 8 GB. Read actual OS/driver/device/memory information after connecting. Do not infer compatible DirectML execution from the model name alone.

Use only Music Mute-scoped install/test/service operations. Do not modify GPU drivers, reset firewall/SSH configuration, disable host verification, alter power policies or reboot without explicit immediate approval.

## 1. Verify transport

Use a named local SSH config entry with owner-supplied values. A schematic example, not ready-to-run credentials:

```sshconfig
Host musicmute-z440-test
    HostName <OWNER_PROVIDED_HOST>
    Port <OWNER_PROVIDED_PORT>
    User <OWNER_PROVIDED_USER>
    IdentityFile <APPROVED_LOCAL_KEY_PATH>
    StrictHostKeyChecking yes
    ServerAliveInterval 20
    ServerAliveCountMax 3
```

Verify the fingerprint out of band before adding its host key. `ssh-keyscan` alone does not authenticate the server. Do not use `StrictHostKeyChecking=no`, inline passwords, a private key copied into the repo, or credentials in evidence.

After verification, start with read-only OS/device and filesystem checks. Establish a dedicated working directory and confirm the existing service/installation state before copying anything. Use correctly quoted PowerShell arguments; do not concatenate untrusted paths into command strings.

## 2. Connect the remote worker to the isolated backend

Prefer an approved test TLS backend address reachable by the Z440. The user agreed to local Mac backend testing; do not expose it to the public internet to make this convenient.

For a strictly local development test, an owner-approved SSH reverse tunnel can carry the Windows loopback API connection back to the Mac loopback backend. Schematic command after verified SSH setup:

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -R 127.0.0.1:43000:127.0.0.1:3000 musicmute-z440-test
```

Verify the backend port and SSH forwarding capability before using this example. Permit cleartext HTTP/WS only for an explicit development loopback profile inside this encrypted tunnel; production remains HTTPS/WSS. A Windows service runs on the same host loopback but must still be tested for actual reachability.

An SSH tunnel is a test transport, not a production architecture requirement. Killing the tunnel should cause lease-safe disconnection handling. For logged-out/reboot tests, use a stable approved backend route; do not confuse a dead management tunnel with failure of the worker's automatic startup.

## 3. Artifact transfer and credential isolation

Build the exact Windows runtime/artifact on the approved build path, verify signatures/digests, then transfer only worker artifacts and scoped synthetic test material. No `.local.env`, AWS access keys, Firebase admin credentials, MongoDB/Redis URLs, backend signing keys or personal audio.

Use a short-lived enrollment code for the test installation. Output URLs are issued by the backend per attempt. The service stores only its machine credential with restrictive ACLs. Use the provider/model pins accepted in B and the actual CLI syntax implemented in D; the package name/version/domain in design examples may not yet be published.

## 4. Separate interactive and service validation

First run the DirectML probe in the agreed nonservice environment, record runtime/provider/device and actual accelerated model output. This only proves that environment.

Then install D's actual Windows Service through approved elevation and repeat the same Kim benchmark/job from the service identity. Record service account, working paths, runtime binary, device selection and output. If GPU access fails in the service context, do not call the platform supported or replace it with a user-login scheduled task silently. Diagnose and report the conflict with the startup requirement.

Test paths containing spaces, permissions to model cache/temp directories, missing PATH entries, multiple service starts and child cleanup. Never run user audio parsers as a more privileged account than necessary to make a test pass.

## 5. End-to-end and failures

Run all recipe combinations through real leased S3 jobs, with default one slot. Test a second slot only after an explicit throughput/memory benchmark permits it. A DirectML session must not execute concurrent inference calls; each child owns its session.

Disconnect SSH while keeping the worker's normal backend route alive to show the service does not depend on the management shell. Separately remove the test backend route to check renewal expiry and job reassignment. Reconnect and verify stale attempt rejection.

Test child crash, supervisor/service restart, graceful drain, repair, optional uninstall and signed candidate rollback. Coordinated logout/reboot is separate owner-approved work. Keep actual outcomes distinct from simulated fixture results.

## 6. Cleanup and report

Revoke test-only enrollment/machine credentials when the run is over, drain before removing services, and delete only the dedicated Music Mute test directory/artifacts. The Mac backend owns exact S3 test cleanup; do not grant the Windows worker bucket deletion/listing permissions for teardown.

Store sanitized evidence with Windows build, GPU driver, chosen provider/package/model/recipe digests, service context, benchmark measurements and remaining blockers. Never upload SSH config containing private connection details or tokens into the PR.
