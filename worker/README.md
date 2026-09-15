# MusicMute shared worker

One Python package owns queue supervision, transfers, recovery, execution evidence
and separation. `musicmute_worker/separation.py` is the only separator source.
The stable launcher and contracts use the standard library; GPU dependencies are
loaded only by the separation runtime. Media policy remains version 2; worker
identity and local installation schema are version 3.

Native installers and signed distribution are under development (I01–I04/H02).
This source archive is not an installer or a qualified GPU recipe. All F01
hardware candidates remain unavailable until actual native evidence is approved.
Do not install candidate dependency combinations globally; W02 must resolve the
documented Python/NumPy and platform wheel conflicts first.

## Integration boundary

Native launchers supply `PlatformAdapter` and `WorkerChild` to `Launcher.run`.
Adapters provide protected credential storage, machine identity, machine-wide
locking and verified descendant containment. Child startup must wait for the
launcher handshake authorization before entering `supervisor.run_loop`.
Windows Job Object and mutex primitives remain in `processes.py`; POSIX process
groups are test/runtime mechanics, not proof of supervisor-crash containment.
Linux/macOS service adapters must provide that proof before enabling claims.

`Config.load` requires an absolute config filename, schema_version 3, approved
worker_id and installation_id, absolute separator in the selected releases root,
and `paths` with seven non-overlapping absolute roots: identity, config, state,
releases, models, journals and events. Native installers protect identity/config
and credentials; state and journals are never relocated relative to cwd.
`installation.json` in the identity root is checked against native protected
`installation-binding` bytes and the machine digest. Repair reuses the exact
binding. Cloned or old installations fail closed without rewriting journals.

The launcher holds exclusion until the child and its descendants are verified
stopped. Failed shutdown preserves launcher-owner.json and forces recovery before
another start. Installer repair/updater must acquire the same adapter lock.
They must not call the lower-level POSIX state-directory lock for global exclusion.
Assignment journals are controlled only by existing owned-attempt recovery.

CLI config validation is available with an absolute path:
`PYTHONPATH=worker python3 -m musicmute_worker --config /absolute/config/config.json --check-config`.
Normal CLI processing fails closed until a native launcher adapter is supplied;
config validation does not prove credentials, GPU qualification or boot readiness.

## Local validation and source packaging

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -v
python3 -m compileall -q worker/musicmute_worker
python3 worker/package.py --output /tmp/MusicMuteWorker-source.zip
```

Native Windows tests remain Windows-gated and use isolated OS object namespaces.
FFmpeg, NumPy/soundfile and GPU/native service proof are distinct gates. Source
packaging includes only allowlisted code/tests and metadata, never local identity,
credentials, runtime releases, model caches or journals. W03 owns signed artifact
verification/events; W04 owns activation policy. No legacy install adapter exists.

## Independent updates and event reporting

`Launcher.maintenance` creates installation-bound control, durable event spool,
TUF verifier, artifact downloader and cache services using protected roots. Native
bootstrap supplies the initial trusted root bytes and configured HTTPS distribution
origin. `ReleaseVerifier.resolve` verifies current TUF metadata and the complete
backend release descriptor; `verify_artifact` checks artifact bytes, and
`extract_artifact` validates the authenticated `bundle.json` before creating a new
stage. These services never activate or execute downloaded code. W04 owns that
lifecycle and must hold the native machine lock for download/cache/spool-upload
mutation; the verifier acquires that lock itself for each metadata refresh.

The private Python 3.12 launcher uses [exact dependency locks](launcher-locks/README.md),
separate from GPU environments. `ControlClient` consumes existing installation or
permanent bearer credentials and fetches server UTC before first event delivery.
`EventSpool.inspect()` exposes pending counts, redacted rejection reason, dropped
counts (including coalesced progress) and retry deadline. SQLite uses synchronous
transactions and a bounded database; storage errors propagate without touching
assignment journals. Native callers report storage errors locally and retry when
space is available. No arbitrary exception text or credentials enter the spool.

For focused checks, use the private launcher Python with `PYTHONPATH=worker` and
`-m unittest discover -s worker/tests -p 'test_update_*.py' -v` or
`-p 'test_event_spool.py' -v`. Tests generate their own isolated signing keys.
Production bootstrap trust delivery, native OS qualification, installer execution
and activation remain separate H01/I01/W04/V01 gates.
