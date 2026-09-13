"""Durable separation-phase measurements, fenced by confirmed stop and attempt."""

import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .progress import atomic_json


def read_execution_telemetry(output: Path):
    path = output / ".execution.json"
    try:
        if path.is_symlink() or path.stat().st_size > 4096:
            return None
        with path.open("rb") as stream:
            raw = stream.read(4097)
        if len(raw) > 4096:
            return None
        return json.loads(raw)
    except (OSError, ValueError, TypeError, RecursionError):
        return None


class ExecutionClock:
    def __init__(self, root: Path, *, monotonic=time.monotonic):
        self.path = root / "execution.json"
        self.monotonic = monotonic
        self.running_since = None
        self.data = None
        if self.path.exists():
            try:
                if self.path.is_symlink() or self.path.stat().st_size > 4096:
                    raise ValueError()
                data = json.loads(self.path.read_text())
                required = {"attemptId", "seconds", "startedAt", "stopped", "complete"}
                optional = {
                    "measurementVersion",
                    "acknowledged",
                    "reconcileEventId",
                    "separationCompleted",
                    "outputRelativePath",
                    "priorComplete",
                }
                if (
                    not isinstance(data, dict)
                    or not required <= set(data) <= required | optional
                    or not isinstance(data["attemptId"], str)
                    or type(data["seconds"]) not in (int, float)
                    or not math.isfinite(data["seconds"])
                    or not 0 <= data["seconds"] <= 86400
                    or type(data["stopped"]) is not bool
                    or type(data["complete"]) is not bool
                    or type(data.get("acknowledged", False)) is not bool
                    or type(data.get("separationCompleted", False)) is not bool
                ):
                    raise ValueError()
                if "outputRelativePath" in data:
                    self._output(data["outputRelativePath"])
                    if type(data.get("priorComplete")) is not bool:
                        raise ValueError()
                if data["startedAt"] is not None:
                    self._date(data["startedAt"])
                self.data = data
                # Previous format timed whole subprocess wall time. It is not
                # trusted separator-only evidence. Nor can a restart fill gaps.
                if not data["stopped"] or data.get("measurementVersion") != 2:
                    data["complete"] = False
                data.setdefault("acknowledged", False)
            except (ValueError, TypeError, KeyError, OverflowError):
                raise RuntimeError("Invalid execution checkpoint") from None

    @staticmethod
    def _date(value):
        result = datetime.fromisoformat(value)
        if result.tzinfo is None or result.utcoffset() is None:
            raise ValueError("Execution timestamp requires timezone")
        return result

    def bind(self, attempt_id):
        if self.data is None or self.data["attemptId"] != attempt_id:
            if (
                self.data
                and self.data["complete"]
                and self.data["startedAt"] is not None
                and not self.data.get("acknowledged")
            ):
                raise RuntimeError("Previous execution evidence is not acknowledged")
            self.data = dict(
                attemptId=attempt_id,
                seconds=0.0,
                startedAt=None,
                stopped=True,
                complete=True,
                measurementVersion=2,
                acknowledged=False,
                separationCompleted=False,
            )
            self.running_since = None
            atomic_json(self.path, self.data)

    def _output(self, relative):
        if (
            not isinstance(relative, str)
            or not relative
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
        ):
            raise ValueError("Invalid execution artifact path")
        root = self.path.parent.resolve()
        output = root / relative
        if output.is_symlink() or not output.resolve().is_relative_to(root):
            raise ValueError("Execution artifact escaped owned storage")
        return output

    def start(self, output=None):
        if self.running_since is not None:
            raise RuntimeError("Separator clock already running")
        if output is not None:
            relative = str(output.resolve().relative_to(self.path.parent.resolve()))
            self._output(relative)
            self.data["outputRelativePath"] = relative
            self.data["priorComplete"] = self.data["complete"]
        self.data["stopped"] = False
        self.data["acknowledged"] = False
        self.data.pop("reconcileEventId", None)
        atomic_json(self.path, self.data)
        # This is only an upper bound/freshness fence, never the billed duration.
        self.running_since = self.monotonic()

    def stop(self, telemetry=None, *, stopped_confirmed=False, run_id=None):
        since = self.running_since
        observed_stop = self.monotonic()
        self.running_since = None
        self.data["stopped"] = stopped_confirmed is True
        measured = None
        if stopped_confirmed is True and since is not None:
            try:
                if (
                    not isinstance(telemetry, dict)
                    or type(telemetry.get("version")) is not int
                    or telemetry.get("version") != 1
                    or telemetry.get("runId") != run_id
                ):
                    raise ValueError()
                phase = telemetry["phase"]
                phase_start = telemetry["startedMonotonic"]
                started_at = self._date(telemetry["startedAt"])
                if (
                    type(phase_start) not in (int, float)
                    or not math.isfinite(phase_start)
                    or not since <= phase_start <= observed_stop
                ):
                    raise ValueError()
                if phase == "separated":
                    measured = telemetry["seconds"]
                elif phase == "separating":
                    # Same invocation, same host monotonic clock; containment was
                    # confirmed stopped after normal cancellation. Startup and
                    # post-separation encoding are outside this child phase.
                    measured = observed_stop - phase_start
                else:
                    raise ValueError()
                if (
                    type(measured) not in (int, float)
                    or not math.isfinite(measured)
                    or not 0 <= measured <= observed_stop - phase_start + 0.001
                ):
                    raise ValueError()
                self.data["startedAt"] = (
                    self.data["startedAt"]
                    or started_at.astimezone(timezone.utc).isoformat()
                )
            except (KeyError, TypeError, ValueError, OverflowError):
                measured = None
        if measured is None:
            self.data["complete"] = False
        else:
            self.data["seconds"] += measured
            self.data["separationCompleted"] = self.data.get(
                "separationCompleted", False
            ) or (
                telemetry.get("phase") == "separated"
                and telemetry.get("completed") is True
            )
        if stopped_confirmed is True:
            self.data.pop("outputRelativePath", None)
            self.data.pop("priorComplete", None)
        atomic_json(self.path, self.data)

    def recover_completed_phase(self, *, stopped_confirmed):
        if stopped_confirmed is not True or not self.data or self.data["stopped"]:
            return
        relative = self.data.get("outputRelativePath")
        if relative is None:
            return
        output = self._output(relative)
        telemetry = read_execution_telemetry(output)
        try:
            if (
                not isinstance(telemetry, dict)
                or telemetry.get("version") != 1
                or telemetry.get("runId") != output.name
                or telemetry.get("phase") != "separated"
            ):
                return
            seconds = telemetry["seconds"]
            if (
                type(seconds) not in (int, float)
                or not math.isfinite(seconds)
                or not 0 <= seconds <= 86400
            ):
                return
            started = self._date(telemetry["startedAt"])
            if self.data.get("priorComplete") is not True:
                return
            self.data["seconds"] += seconds
            self.data["startedAt"] = (
                self.data["startedAt"] or started.astimezone(timezone.utc).isoformat()
            )
            self.data["stopped"] = True
            self.data["complete"] = True
            self.data["separationCompleted"] = (
                self.data.get("separationCompleted", False)
                or telemetry.get("completed") is True
            )
            self.data.pop("outputRelativePath", None)
            self.data.pop("priorComplete", None)
            atomic_json(self.path, self.data)
        except (KeyError, TypeError, ValueError, OverflowError):
            return

    def evidence(self, event_id, duration):
        if (
            not self.data
            or not self.data["complete"]
            or not self.data["stopped"]
            or self.data["startedAt"] is None
            or type(duration) not in (int, float)
            or not math.isfinite(duration)
            or duration <= 0
        ):
            return None
        return dict(
            eventId=event_id,
            separatorExecutionSeconds=self.data["seconds"],
            processingStartedAt=self.data["startedAt"],
            measuredAudioSeconds=duration,
            stoppedConfirmed=True,
            **(
                {"separationCompleted": self.data["separationCompleted"]}
                if "separationCompleted" in self.data
                else {}
            ),
        )

    def reconciliation(self, attempt_id, duration):
        if not self.data or self.data["attemptId"] != attempt_id:
            return None
        event_id = self.data.get("reconcileEventId") or str(uuid4())
        evidence = self.evidence(event_id, duration)
        if evidence is None:
            return None
        self.data["reconcileEventId"] = event_id
        atomic_json(self.path, self.data)
        return dict(eventId=event_id, executionEvidence=evidence)

    def acknowledge(self, attempt_id):
        if self.data and self.data["attemptId"] == attempt_id:
            self.data["acknowledged"] = True
            atomic_json(self.path, self.data)
