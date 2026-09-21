import { describe, expect, it } from "vitest";

import { workerRecipeLabel } from "./worker-recipes";

describe("worker recipe presentation", () => {
  it.each([
    ["kim-vocals-v1", "Kim Vocal 2"],
    ["kim-vocals-trim-v1", "Kim Vocal 2 · Gap trimming"],
    ["kim-vocals-denoise-v1", "Kim Vocal 2 · Denoise"],
    ["kim-vocals-denoise-trim-v1", "Kim Vocal 2 · Denoise and gap trimming"],
  ])("labels %s as a Kim Vocal 2 recipe", (recipeId, label) => {
    expect(workerRecipeLabel(recipeId)).toBe(label);
  });

  it("keeps an unknown future recipe identifiable", () => {
    expect(workerRecipeLabel("future-recipe-v3")).toBe("future-recipe-v3");
  });
});
