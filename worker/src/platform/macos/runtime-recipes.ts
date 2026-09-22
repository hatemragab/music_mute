import type { WorkerRecipeId } from "../../../protocol/v1/protocol.js";

export const MAC_RECIPE_IDS = [
  "kim-vocals-v2",
  "kim-vocals-v2-trim",
] as const satisfies readonly WorkerRecipeId[];

export type MacRecipeId = (typeof MAC_RECIPE_IDS)[number];

export const DEFAULT_MAC_RECIPE_ID: MacRecipeId = "kim-vocals-v2-trim";
