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
        "kim-vocals-v1": "6028cde28fb5630630553881d15651cab4cd688ae49eb2935c25ed8e2acdd551",
        "kim-vocals-trim-v1": "1a70379331fafb360f4cd388e17f4c6ce511031e4082f34ba63676957d8c34c3",
        "kim-vocals-denoise-v1": "5d6d9256e173c38e844e9714a61469311cd7afc53a5a71e64b666d56f81848d3",
        "kim-vocals-denoise-trim-v1": "11108d3034ab11a5a099863d2832268de44cea000d5a46c335b826cac2c78be5",
    }

    def test_catalog_contains_only_the_four_frozen_combinations(self) -> None:
        self.assertEqual(
            set(RECIPE_DEFINITIONS),
            {
                "kim-vocals-v1",
                "kim-vocals-trim-v1",
                "kim-vocals-denoise-v1",
                "kim-vocals-denoise-trim-v1",
            },
        )
        self.assertEqual(DEFAULT_RECIPE_ID, "kim-vocals-trim-v1")
        for recipe_id, definition in RECIPE_DEFINITIONS.items():
            snapshot = recipe_snapshot(recipe_id)
            self.assertEqual(snapshot["recipeDigest"], self.EXPECTED_DIGESTS[recipe_id])
            self.assertEqual(snapshot["trimEnabled"], definition.trim_enabled)
            self.assertEqual(snapshot["denoiseEnabled"], definition.denoise_enabled)
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
        tampered = {**snapshot, "trimEnabled": False}
        with self.assertRaises(RecipeValidationError):
            validate_recipe_snapshot(tampered)
        with self.assertRaises(RecipeValidationError):
            validate_recipe_snapshot({**snapshot, "url": "https://example.invalid"})


if __name__ == "__main__":
    unittest.main()
