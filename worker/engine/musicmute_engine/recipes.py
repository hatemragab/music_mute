"""Immutable worker recipe catalog shared with the backend contract."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Mapping

MODEL_FILENAME = "Kim_Vocal_2.onnx"
MODEL_SHA256 = "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b"
MODEL_BYTES = 66_759_214
MODEL_SOURCE = (
    "https://github.com/TRvlvr/model_repo/releases/download/"
    "all_public_uvr_models/Kim_Vocal_2.onnx"
)
PREPARATION_PROFILE_ID = "pcm16-stereo-44100-v1"
OUTPUT_FORMAT = "mp3"
OUTPUT_BITRATE_KBPS = 160

BASE_STEPS = (
    "prepare-pcm16-stereo-44100-v1",
    "separate-kim-vocal-2-v1",
)
FINAL_STEPS = ("encode-mp3-up-to-160k-v1", "validate-audio-v1")
TRIM_STEP = "trim-vocal-gaps-v1"


class RecipeValidationError(ValueError):
    """Raised when a backend recipe snapshot is not an exact catalog entry."""


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def recipe_digest(snapshot_without_digest: Mapping[str, Any]) -> str:
    material = {
        key: value
        for key, value in snapshot_without_digest.items()
        if key != "recipeDigest"
    }
    return hashlib.sha256(canonical_json(material).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class RecipeDefinition:
    recipe_id: str
    trim_enabled: bool = False
    denoise_enabled: bool = False

    def snapshot(self) -> dict[str, Any]:
        steps = [*BASE_STEPS]
        if self.trim_enabled:
            steps.append(TRIM_STEP)
        steps.extend(FINAL_STEPS)
        snapshot: dict[str, Any] = {
            "recipeId": self.recipe_id,
            "recipeRevision": 3,
            "protocolVersion": 1,
            "modelFilename": MODEL_FILENAME,
            "modelDigest": MODEL_SHA256,
            "modelBytes": MODEL_BYTES,
            "preparationProfileId": PREPARATION_PROFILE_ID,
            "stepIds": steps,
            "trimEnabled": self.trim_enabled,
            "denoiseEnabled": self.denoise_enabled,
            "denoisePresetId": None,
            "trimProfileId": TRIM_STEP if self.trim_enabled else None,
            "outputFormat": OUTPUT_FORMAT,
            "outputBitrateKbps": OUTPUT_BITRATE_KBPS,
        }
        snapshot["recipeDigest"] = recipe_digest(snapshot)
        return snapshot


RECIPE_DEFINITIONS = {
    "kim-vocals-v2": RecipeDefinition("kim-vocals-v2"),
    "kim-vocals-v2-trim": RecipeDefinition(
        "kim-vocals-v2-trim", trim_enabled=True
    ),
}
DEFAULT_RECIPE_ID = "kim-vocals-v2-trim"
SNAPSHOT_KEYS = frozenset((*next(iter(RECIPE_DEFINITIONS.values())).snapshot().keys(),))


def recipe_snapshot(recipe_id: str) -> dict[str, Any]:
    try:
        return RECIPE_DEFINITIONS[recipe_id].snapshot()
    except KeyError as error:
        raise RecipeValidationError("Unknown worker recipe") from error


def validate_recipe_snapshot(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != SNAPSHOT_KEYS:
        raise RecipeValidationError("Recipe snapshot fields are invalid")
    recipe_id = value.get("recipeId")
    if not isinstance(recipe_id, str):
        raise RecipeValidationError("Recipe ID is invalid")
    expected = recipe_snapshot(recipe_id)
    if value != expected:
        raise RecipeValidationError("Recipe snapshot does not match the catalog")
    return dict(expected)
