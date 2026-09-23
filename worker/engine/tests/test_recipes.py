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
        "kim-vocals-v2": "af00fff596b93554498142a731c4d161a706614438e0d5643f804c08f49c1ff1",
        "kim-vocals-v2-trim": "2989b222ff771dc1abfd44fbe46e37bd65e79478fb410ee2c1b565c122fa6e05",
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
            self.assertEqual(snapshot["outputBitrateKbps"], 160)
            self.assertEqual(snapshot["recipeRevision"], 3)
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
        tampered = {**snapshot, "outputBitrateKbps": 320}
        with self.assertRaises(RecipeValidationError):
            validate_recipe_snapshot(tampered)
        with self.assertRaises(RecipeValidationError):
            validate_recipe_snapshot({**snapshot, "url": "https://example.invalid"})


if __name__ == "__main__":
    unittest.main()
