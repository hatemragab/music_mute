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
INPUT_PROFILE_ID = "direct-input-v1"
OUTPUT_FORMAT = "mp3"
OUTPUT_BITRATE_KBPS = 160

BASE_STEPS = ("separate-kim-vocal-2-wav-v1",)
FINAL_STEPS = ("validate-audio-v1",)
TRIM_STEP = "trim-vocal-wav-v1"
TRIM_ENCODE_STEP = "encode-mp3-up-to-160k-v1"


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
    trim_enabled: bool = True
    denoise_enabled: bool = False

    def snapshot(self, revision: int = 6) -> dict[str, Any]:
        steps = [*BASE_STEPS]
        if self.trim_enabled:
            steps.append(TRIM_STEP)
        if self.trim_enabled or revision >= 6:
            steps.append(TRIM_ENCODE_STEP)
        steps.extend(FINAL_STEPS)
        snapshot: dict[str, Any] = {
            "recipeId": self.recipe_id,
            "recipeRevision": revision,
            "protocolVersion": 1,
            "modelFilename": MODEL_FILENAME,
            "modelDigest": MODEL_SHA256,
            "modelBytes": MODEL_BYTES,
            "inputProfileId": INPUT_PROFILE_ID,
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
DEFAULT_RECIPE_ID = "kim-vocals-v2"
SNAPSHOT_KEYS = frozenset((*next(iter(RECIPE_DEFINITIONS.values())).snapshot().keys(),))


def recipe_snapshot(recipe_id: str, trim_enabled: bool = True, revision: int = 6) -> dict[str, Any]:
    try:
        RECIPE_DEFINITIONS[recipe_id]
        return RecipeDefinition(recipe_id, trim_enabled=trim_enabled).snapshot(revision)
    except KeyError as error:
        raise RecipeValidationError("Unknown worker recipe") from error


def validate_recipe_snapshot(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != SNAPSHOT_KEYS:
        raise RecipeValidationError("Recipe snapshot fields are invalid")
    recipe_id = value.get("recipeId")
    if not isinstance(recipe_id, str):
        raise RecipeValidationError("Recipe ID is invalid")
    revision = value.get("recipeRevision")
    trim_enabled = value.get("trimEnabled")
    if type(revision) is not int or revision not in (5, 6) or type(trim_enabled) is not bool:
        raise RecipeValidationError("Recipe revision or trim flag is invalid")
    if revision == 5 and not trim_enabled:
        raise RecipeValidationError("Legacy recipes require trimming")
    expected = recipe_snapshot(recipe_id, trim_enabled, revision)
    if value != expected:
        raise RecipeValidationError("Recipe snapshot does not match the catalog")
    return dict(expected)
