const WORKER_RECIPE_LABELS: Readonly<Record<string, string>> = {
  "kim-vocals-v2": "Kim Vocal 2",
  "kim-vocals-v2-trim": "Kim Vocal 2 + vocal-gap trim",
};

export const workerRecipeLabel = (recipeId: string) =>
  WORKER_RECIPE_LABELS[recipeId] ?? recipeId;
