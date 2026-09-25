from __future__ import annotations

import unittest

from musicmute_engine.recipes import (
    DEFAULT_RECIPE_ID,
    RECIPE_DEFINITIONS,
    RecipeValidationError,
    recipe_snapshot,
    validate_recipe_snapshot,
)


class RecipeCatalogTests(unittest.TestCase):
    EXPECTED_DIGESTS = {
        "kim-vocals-v2": "6adf28da3329ada0d4670c308f163553dc7ad4f9b2d07dad8ec8b86b47fe6e6a",
        "kim-vocals-v2-trim": "97198c83fd88101420299121bf6ef0f81d350f6228762c2892d817283241fc04",
    }

    def test_catalog_contains_mandatory_trim_recipes(self) -> None:
        self.assertEqual(
            set(RECIPE_DEFINITIONS),
            {"kim-vocals-v2", "kim-vocals-v2-trim"},
        )
        self.assertEqual(DEFAULT_RECIPE_ID, "kim-vocals-v2")
        for recipe_id, definition in RECIPE_DEFINITIONS.items():
            snapshot = recipe_snapshot(recipe_id)
            self.assertEqual(snapshot["recipeDigest"], self.EXPECTED_DIGESTS[recipe_id])
            self.assertEqual(snapshot["trimEnabled"], definition.trim_enabled)
            self.assertEqual(snapshot["denoiseEnabled"], definition.denoise_enabled)
            self.assertEqual(snapshot["outputBitrateKbps"], 160)
            self.assertEqual(snapshot["recipeRevision"], 6)
            self.assertEqual(
                "trim-vocal-wav-v1" in snapshot["stepIds"],
                definition.trim_enabled,
            )
            self.assertEqual(snapshot["inputProfileId"], "direct-input-v1")
            self.assertEqual(
                "denoise-afftdn-conservative-v1" in snapshot["stepIds"],
                definition.denoise_enabled,
            )

    def test_no_trim_and_legacy_snapshots_are_exact_catalog_entries(self) -> None:
        for recipe_id in RECIPE_DEFINITIONS:
            full = recipe_snapshot(recipe_id, False)
            self.assertEqual(validate_recipe_snapshot(full), full)
            self.assertNotIn("trim-vocal-wav-v1", full["stepIds"])
            self.assertIn("encode-mp3-up-to-160k-v1", full["stepIds"])
            self.assertIsNone(full["trimProfileId"])
            legacy = recipe_snapshot(recipe_id, True, 5)
            self.assertEqual(validate_recipe_snapshot(legacy), legacy)
            with self.assertRaises(RecipeValidationError):
                validate_recipe_snapshot(recipe_snapshot(recipe_id, False, 5))

    def test_snapshot_validation_rejects_tampering_and_unknown_fields(self) -> None:
        snapshot = recipe_snapshot(DEFAULT_RECIPE_ID)
        self.assertEqual(validate_recipe_snapshot(snapshot), snapshot)
        tampered = {**snapshot, "outputBitrateKbps": 320}
        with self.assertRaises(RecipeValidationError):
            validate_recipe_snapshot(tampered)
        with self.assertRaises(RecipeValidationError):
            validate_recipe_snapshot({**snapshot, "url": "https://example.invalid"})


if __name__ == "__main__":
    unittest.main()
