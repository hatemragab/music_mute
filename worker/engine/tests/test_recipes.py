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
        "kim-vocals-v2": "ebc14b7b566b876246d260fe7807e513b183eb639ad7199c61e50ae8424222c6",
        "kim-vocals-v2-trim": "c972a312647859a262ba9390705f7296c9f7a30359c33cefc44a6955356ac590",
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
            self.assertEqual(snapshot["recipeRevision"], 5)
            self.assertEqual(
                "trim-vocal-wav-v1" in snapshot["stepIds"],
                definition.trim_enabled,
            )
            self.assertEqual(snapshot["inputProfileId"], "direct-input-v1")
            self.assertEqual(
                "denoise-afftdn-conservative-v1" in snapshot["stepIds"],
                definition.denoise_enabled,
            )

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
