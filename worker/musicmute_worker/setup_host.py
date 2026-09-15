"""Common native-host assembly and fail-closed command entrypoint.

I02-I04 statically bind their OS adapter here when implemented. A configuration
file never selects an import, executable, callback, or replacement trust root.
"""

import argparse
import time
from contextlib import contextmanager
from pathlib import Path

from .installation_state import InstallationState
from .installer import Installer
from .launcher import Launcher
from .setup_control import CommandMailbox
from .setup_runtime import SharedActivationRuntime
from .update.coordinator import UpdateCoordinator
from .update.journal import ClaimHold, DurableRecords
from .update.policy import ControlClient


def import_native_events(paths, native, spool):
    from .bootstrap_events import import_bootstrap_events

    if not callable(getattr(native, "acquire_bootstrap_lock", None)):
        raise TypeError("Native bootstrap handoff lock is required")
    with native.acquire_bootstrap_lock():
        return import_bootstrap_events(paths.events / "bootstrap", spool)


def assemble(
    paths,
    adapter,
    native,
    *,
    api_base_url,
    bootstrap_root,
    distribution_origin,
    launcher_build,
    stage=None,
    http_open=None,
):
    """Called only under the native machine lock; lifetime ends with that lock."""
    from .events import EventSpool
    from .update.download import ArtifactDownloader, DistributionOrigin
    from .update.policy import ArtifactCache
    from .update.trust import ReleaseVerifier

    active = True

    @contextmanager
    def owned_lock():
        if not active:
            raise RuntimeError("Setup services escaped machine lock")
        yield

    records = DurableRecords(
        paths.state / "setup", sync_directory=native.sync_directory
    )
    state = InstallationState(records, adapter, api_base_url)
    setup = ControlClient(
        api_base_url,
        state.identity["installationId"],
        state.identity["installationToken"],
        setup=True,
        http_open=http_open,
    )

    def permanent():
        return ControlClient(
            api_base_url,
            state.identity["installationId"],
            adapter.load_secret("worker-token").decode(),
            http_open=http_open,
        )

    origin = DistributionOrigin(distribution_origin)
    services = {
        "client": permanent() if state.value["workerId"] else setup,
        "events": EventSpool(paths.events, state.identity["installationId"]),
        "verifier": ReleaseVerifier(
            paths.state / "update-metadata", origin, bootstrap_root, owned_lock
        ),
        "downloader": ArtifactDownloader(origin),
        "cache": ArtifactCache(paths.state / "update-artifacts"),
    }
    import_native_events(paths, native, services["events"])
    runtime = SharedActivationRuntime(
        paths,
        DurableRecords(paths.state / "updates", sync_directory=native.sync_directory),
        services["verifier"],
        services["client"],
        native,
        state.identity["installationId"],
        launcher_build,
    )
    installer = Installer(
        state, setup, permanent, runtime, services, native, stage=stage
    )
    try:
        yield installer
    finally:
        from .events import EventRequestError

        try:
            services["events"].upload_pending(
                permanent() if state.value["workerId"] else setup
            )
        except (OSError, EventRequestError, ValueError):
            pass  # Durable spool retains failed/uncertain delivery for the next run.
        active = False


assemble = contextmanager(assemble)


def run_action(
    paths,
    adapter,
    native,
    action,
    *,
    launcher_path=None,
    installer_build=1,
    **options,
):
    """Submit live-service controls without waiting on its lifetime exclusion."""
    if action == "status":
        value = DurableRecords(paths.state / "setup", create=False).read("setup.json")
        return (
            {
                key: value[key]
                for key in (
                    "installationId",
                    "workerId",
                    "stage",
                    "pairingState",
                    "failures",
                )
            }
            if value
            else {"stage": "not_installed"}
        )
    running = native.service_running()
    if type(running) is not bool:
        raise RuntimeError("Native service liveness is unavailable")
    if running:
        if action not in ("repair", "pause", "uninstall"):
            raise RuntimeError("Existing worker service owns setup; use repair")
        mailbox = CommandMailbox(
            DurableRecords(
                paths.state / "commands", sync_directory=native.sync_directory
            )
        )
        return {"operationId": mailbox.submit(action), "result": "queued"}
    with adapter.acquire_machine_lock():
        if (paths.journals / "launcher-owner.json").exists():
            Launcher(paths, adapter).recover_ownership_locked()
        return _run_action_locked(
            paths,
            adapter,
            native,
            action,
            launcher_path=launcher_path,
            installer_build=installer_build,
            **options,
        )


def _run_action_locked(
    paths, adapter, native, action, *, launcher_path, installer_build, **options
):
    with assemble(paths, adapter, native, **options) as installer:
        if action in ("install", "pairing-retry"):
            result = installer.install(
                launcher_path=launcher_path,
                installer_build=installer_build,
                retry_pairing=action == "pairing-retry",
            )
            return installer.poll_pairing() if result == "pending" else result
        if action not in ("repair", "pause", "status", "uninstall"):
            raise ValueError("Invalid setup action")
        return getattr(installer, action)()


def run_worker(
    paths,
    adapter,
    native,
    client,
    *,
    bootstrap_root,
    distribution_origin,
    launcher_build,
):
    """Recover W04 before resolving the actual child environment under one lock."""
    runtime = None
    next_policy = 0.0

    def restore_readiness(current, *, stop=False):
        record = current.records.read("activation.json")
        if record and record["phase"] not in ("committed", "rolled_back"):
            return False  # W04 alone owns an incomplete/quarantined transaction.
        ClaimHold(current.records).set(True)
        candidate = current.pointer.read()
        boundary = current.stop_and_reconcile(candidate) if stop else current.boundary()
        if not boundary.safe or current.validate(candidate) is not True:
            return False
        client.post_runtime(current.runtime_report(candidate))
        receipt = client.installation_ready(current.readiness_body(candidate))
        if receipt.get("accepted") is True and receipt.get("canClaim") is True:
            ClaimHold(current.records).set(False)
            return True
        return False

    def local_commands(current, *, starting=False):
        mailbox = CommandMailbox(
            DurableRecords(
                paths.state / "commands", sync_directory=native.sync_directory
            )
        )
        for command in mailbox.pending():
            ClaimHold(current.records).set(True)
            if command["action"] == "pause":
                current.records.write(
                    "local-pause.json", {"schemaVersion": 3, "paused": True}
                )
                mailbox.finish(command["operationId"], "paused")
                continue
            candidate = current.pointer.read()
            if not current.stop_and_reconcile(candidate).safe:
                continue
            if command["action"] == "uninstall":
                if native.remove_boot_service() is not True:
                    raise RuntimeError("SERVICE_FAILED")
                mailbox.finish(command["operationId"], "service_removed_state_retained")
                return 76
            if current.validate(candidate) is not True:
                raise RuntimeError("GPU_QUALIFICATION_FAILED")
            client.post_runtime(current.runtime_report(candidate))
            receipt = client.installation_ready(current.readiness_body(candidate))
            if receipt.get("accepted") is True and receipt.get("canClaim") is True:
                current.records.write(
                    "local-pause.json", {"schemaVersion": 3, "paused": False}
                )
                ClaimHold(current.records).set(False)
                mailbox.finish(command["operationId"], "repaired")
                return None if starting else 75
        return None

    def lifecycle(factory):
        nonlocal runtime
        services = factory(
            client,
            bootstrap_root=bootstrap_root,
            distribution_origin=distribution_origin,
        )
        records = DurableRecords(
            paths.state / "updates", sync_directory=native.sync_directory
        )
        runtime = SharedActivationRuntime(
            paths,
            records,
            services["verifier"],
            client,
            native,
            client.installation_id,
            launcher_build,
        )
        coordinator = UpdateCoordinator(records, paths.releases, services, runtime)
        if local_commands(runtime, starting=True) == 76:
            return False
        paused = records.read("local-pause.json")
        if paused and paused.get("paused") is not False:
            ClaimHold(records).set(True)
            return False
        result = coordinator.recover_interrupted_activation()
        if result == "none":
            decision = client.fetch_policy()
            if decision["action"] == "prepare":
                coordinator.prepare()
                coordinator.activate_when_idle()
            elif decision["action"] == "hold":
                ClaimHold(records).set(True)
            elif decision["action"] == "none":
                # Prior process readiness is never boot evidence for this start.
                if not restore_readiness(runtime):
                    return False
        return not ClaimHold(records).held

    def monitor(factory, child):
        nonlocal next_policy
        from .events import EventRequestError
        from .profiles import ProfileError

        services = factory(
            client,
            bootstrap_root=bootstrap_root,
            distribution_origin=distribution_origin,
        )
        # The prior callback's verifier lease expired; use this callback's lease.
        runtime.verifier = services["verifier"]
        try:
            command_result = local_commands(runtime)
            if command_result is not None:
                return command_result
            paused = runtime.records.read("local-pause.json")
            if paused and paused.get("paused") is not False:
                ClaimHold(runtime.records).set(True)
                return None
            now = time.monotonic()
            if now < next_policy:
                return None
            next_policy = now + 30
            services["events"].upload_pending(client)
            coordinator = UpdateCoordinator(
                runtime.records, paths.releases, services, runtime
            )
            coordinator.verify_available_processing()
            policy = client.fetch_policy()
            if policy["action"] == "hold":
                ClaimHold(runtime.records).set(True)
            elif policy["action"] == "prepare":
                if coordinator.running_target(policy) is True:
                    if ClaimHold(runtime.records).held and restore_readiness(
                        runtime, stop=True
                    ):
                        return 75
                    return None
                ClaimHold(runtime.records).set(True)
                prepared = coordinator.prepare()
                if prepared not in ("prepared", "waiting"):
                    return None
                if not runtime.stop_and_reconcile(runtime.pointer.read()).safe:
                    return None
                coordinator.activate_when_idle()
                return 75
            elif (
                policy["action"] == "none"
                and ClaimHold(runtime.records).held
                and restore_readiness(runtime, stop=True)
            ):
                return 75
        except (OSError, EventRequestError):
            # Offline control never clears a hold or kills an owned assignment.
            ClaimHold(runtime.records).set(True)
        except (ProfileError, ValueError, RuntimeError) as error:
            # Invalid metadata/dependencies must not terminate a busy assignment.
            ClaimHold(runtime.records).set(True)
            runtime.records.write(
                "maintenance-failure.json",
                {
                    "schemaVersion": 3,
                    "code": error.code
                    if isinstance(error, ProfileError)
                    else "UPDATE_SIGNATURE_INVALID",
                },
            )
        return None

    while True:
        result = Launcher(paths, adapter).run(
            lambda: runtime.child(), lifecycle=lifecycle, monitor=monitor
        )
        if result != 75:
            return result


def run_service(paths, native, config):
    """The LaunchDaemon/systemd/Windows-service entry: supervise, never install.

    It builds its own permanent credential client and refuses when the machine is
    not already paired. The service never registers, never pairs and never
    changes stored identity; those remain the operator entrypoint's job.
    """
    from .launcher import InstallationBinding, verify_binding

    binding = InstallationBinding.load(paths.identity / "installation.json")
    # Raises when the machine or the protected binding no longer matches.
    verify_binding(paths, native)
    client = ControlClient(
        binding.api_base_url,
        binding.installation_id,
        native.load_secret("worker-token").decode(),
    )
    return run_worker(
        paths,
        native,
        native,
        client,
        bootstrap_root=config.bootstrap_root.read_bytes(),
        distribution_origin=config.distribution_origin,
        launcher_build=config.launcher_build,
    )


def main(argv=None):
    """Native entrypoint: statically resolve this OS's host, then act.

    A configuration file never selects an implementation, an executable or a
    trust root. The OS comes from local detection, the host from
    `platforms.registry`, and the trust root from the verified bootstrap stage
    named in the protected bootstrap configuration.
    """
    from .platforms.registry import open_host, safe_reason
    from .setup_config import SetupHostConfig

    parser = argparse.ArgumentParser(description="MusicMute native setup host")
    parser.add_argument(
        "--action",
        choices=("install", "repair", "pause", "status", "uninstall", "pairing-retry"),
    )
    parser.add_argument("--service", action="store_true")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args(argv)
    if (args.action is None) == (not args.service):
        print("STARTUP_INSTALL_FAILED: choose exactly one of --action or --service.")
        return 2
    try:
        config = SetupHostConfig.load(args.config)
        native = open_host(config)
    except (OSError, ValueError, RuntimeError, TypeError) as error:
        # Safe public code only; raw native exception text never reaches a log.
        code = safe_reason(getattr(error, "args", ("",))[0] or "")
        print(f"{code}: native setup host is unavailable on this machine.")
        return 2
    try:
        if args.service:
            return run_service(config.paths, native, config)
        result = run_action(
            config.paths,
            native,
            native,
            args.action,
            launcher_path=str(config.launcher_path),
            installer_build=config.installer_build,
            api_base_url=config.api_base_url,
            bootstrap_root=config.bootstrap_root,
            distribution_origin=config.distribution_origin,
            launcher_build=config.launcher_build,
            stage=config.stage,
        )
    except (OSError, ValueError, RuntimeError) as error:
        code = safe_reason(
            getattr(error, "code", "") or getattr(error, "args", ("",))[0]
        )
        print(f"{code}: setup stopped before completion.")
        return 1
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
