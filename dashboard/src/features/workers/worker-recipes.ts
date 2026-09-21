const WORKER_RECIPE_LABELS: Readonly<Record<string, string>> = {
  "kim-vocals-v1": "Kim Vocal 2",
  "kim-vocals-trim-v1": "Kim Vocal 2 · Gap trimming",
  "kim-vocals-denoise-v1": "Kim Vocal 2 · Denoise",
  "kim-vocals-denoise-trim-v1": "Kim Vocal 2 · Denoise and gap trimming",
};

export const workerRecipeLabel = (recipeId: string) =>
  WORKER_RECIPE_LABELS[recipeId] ?? recipeId;
