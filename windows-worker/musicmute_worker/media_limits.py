"""Validated assignment limits; old jobs retain their exclusive boundaries."""

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class MediaLimits:
    policy_version: int = 1
    max_duration_seconds: float = 600
    duration_inclusive: bool = False
    max_input_bytes: int = 30_000_000
    input_bytes_inclusive: bool = False
    max_output_bytes: int = 30_000_000
    output_bytes_inclusive: bool = False
    probe_timeout_seconds: int = 30
    processing_timeout_seconds: int = 7200
    cost_model_revision: str | None = None

    def accepts_duration(self, value):
        return (
            type(value) in (int, float)
            and math.isfinite(value)
            and value > 0
            and (
                value <= self.max_duration_seconds
                if self.duration_inclusive
                else value < self.max_duration_seconds
            )
        )

    def accepts_input_bytes(self, value):
        return self._accepts_bytes(
            value, self.max_input_bytes, self.input_bytes_inclusive
        )

    def accepts_output_bytes(self, value):
        return self._accepts_bytes(
            value, self.max_output_bytes, self.output_bytes_inclusive
        )

    @staticmethod
    def _accepts_bytes(value, maximum, inclusive):
        return (
            type(value) is int
            and value > 0
            and (value <= maximum if inclusive else value < maximum)
        )

    def to_wire(self):
        return {
            "policyVersion": self.policy_version,
            "maxDurationSeconds": self.max_duration_seconds,
            "durationInclusive": self.duration_inclusive,
            "maxInputBytes": self.max_input_bytes,
            "inputBytesInclusive": self.input_bytes_inclusive,
            "maxOutputBytes": self.max_output_bytes,
            "outputBytesInclusive": self.output_bytes_inclusive,
            "probeTimeoutSeconds": self.probe_timeout_seconds,
            "processingTimeoutSeconds": self.processing_timeout_seconds,
            "costModelRevision": self.cost_model_revision,
        }


def effective_media_limits(
    assignment, local_output_max_bytes=30_000_000, local_timeout_seconds=7200
):
    if (
        type(local_output_max_bytes) is not int
        or not 1024 <= local_output_max_bytes <= 100_000_000
    ):
        raise ValueError("Invalid local output safety ceiling")
    if (
        type(local_timeout_seconds) is not int
        or not 1 <= local_timeout_seconds <= 86400
    ):
        raise ValueError("Invalid local execution safety ceiling")
    value = assignment.get("processingLimits")
    if value is None:
        return MediaLimits(
            max_output_bytes=local_output_max_bytes,
            processing_timeout_seconds=local_timeout_seconds,
        )
    required = set(MediaLimits().to_wire())
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("Invalid assignment media limits")
    version = value["policyVersion"]
    if type(version) is not int or version not in (1, 2):
        raise ValueError("Unsupported assignment policy version")
    for field, ceiling in (
        ("maxInputBytes", 100_000_000),
        ("maxOutputBytes", 100_000_000),
        ("probeTimeoutSeconds", 600),
        ("processingTimeoutSeconds", 86400),
    ):
        if type(value[field]) is not int or not 0 < value[field] <= ceiling:
            raise ValueError("Invalid assignment resource ceiling")
    duration = value["maxDurationSeconds"]
    if (
        type(duration) not in (int, float)
        or not math.isfinite(duration)
        or not 0 < duration <= 1800
    ):
        raise ValueError("Invalid assignment duration ceiling")
    for field in ("durationInclusive", "inputBytesInclusive", "outputBytesInclusive"):
        if type(value[field]) is not bool:
            raise ValueError("Invalid assignment boundary")
    revision = value["costModelRevision"]
    if revision is not None and (
        not isinstance(revision, str) or not 1 <= len(revision) <= 128
    ):
        raise ValueError("Invalid cost model revision")
    if version == 1 and (
        duration > 600
        or value["maxInputBytes"] > 30_000_000
        or value["durationInclusive"]
        or value["inputBytesInclusive"]
    ):
        raise ValueError("Legacy assignment limits cannot expand")
    return MediaLimits(
        version,
        duration,
        value["durationInclusive"],
        value["maxInputBytes"],
        value["inputBytesInclusive"],
        min(value["maxOutputBytes"], local_output_max_bytes),
        value["outputBytesInclusive"]
        and value["maxOutputBytes"] < local_output_max_bytes,
        value["probeTimeoutSeconds"],
        min(value["processingTimeoutSeconds"], local_timeout_seconds),
        revision,
    )
