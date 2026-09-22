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
        "kim-vocals-v2": "4d5075f55c3adad6712d4f823e3455df1189f8fa064d3b173317c3adbc46b17a",
        "kim-vocals-v2-trim": "8dc89087f05cfe5e561b66e5091a75cdd50f42a2ebf69cbac374b31e3767b11d",
    }

    def test_catalog_contains_plain_and_legacy_compatible_trim_recipes(self) -> None:
        self.assertEqual(
            set(RECIPE_DEFINITIONS),
            {"kim-vocals-v2", "kim-vocals-v2-trim"},
        )
        self.assertEqual(DEFAULT_RECIPE_ID, "kim-vocals-v2-trim")
        for recipe_id, definition in RECIPE_DEFINITIONS.items():
            snapshot = recipe_snapshot(recipe_id)
            self.assertEqual(snapshot["recipeDigest"], self.EXPECTED_DIGESTS[recipe_id])
            self.assertEqual(snapshot["trimEnabled"], definition.trim_enabled)
            self.assertEqual(snapshot["denoiseEnabled"], definition.denoise_enabled)
            self.assertEqual(snapshot["outputBitrateKbps"], 320)
            self.assertEqual(
                "trim-vocal-gaps-v1" in snapshot["stepIds"],
                definition.trim_enabled,
            )
            self.assertEqual(
                "denoise-afftdn-conservative-v1" in snapshot["stepIds"],
                definition.denoise_enabled,
            )

    def test_snapshot_validation_rejects_tampering_and_unknown_fields(self) -> None:
        snapshot = recipe_snapshot(DEFAULT_RECIPE_ID)
        self.assertEqual(validate_recipe_snapshot(snapshot), snapshot)
        tampered = {**snapshot, "outputBitrateKbps": 192}
        with self.assertRaises(RecipeValidationError):
            validate_recipe_snapshot(tampered)
        with self.assertRaises(RecipeValidationError):
            validate_recipe_snapshot({**snapshot, "url": "https://example.invalid"})


if __name__ == "__main__":
    unittest.main()
