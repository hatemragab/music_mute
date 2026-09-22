import { describe, expect, it } from "vitest";

import { workerRecipeLabel } from "./worker-recipes";

describe("worker recipe presentation", () => {
  it.each([
    ["kim-vocals-v2", "Kim Vocal 2"],
    ["kim-vocals-v2-trim", "Kim Vocal 2 + vocal-gap trim"],
  ])("labels %s as a Kim Vocal 2 recipe", (recipeId, label) => {
    expect(workerRecipeLabel(recipeId)).toBe(label);
  });

  it("keeps an unknown future recipe identifiable", () => {
    expect(workerRecipeLabel("future-recipe-v3")).toBe("future-recipe-v3");
  });
});
