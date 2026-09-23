/** Stages reported by the Python processing child, in execution order. */
export const CHILD_PROGRESS_STAGES = [
  "input-validation",
  "preparation",
  "model-load",
  "separation",
  "denoise",
  "trim",
  "encoding",
  "output-validation",
  "output-ready",
] as const;

export type ChildProgressStage = (typeof CHILD_PROGRESS_STAGES)[number];

export interface ChildProgress {
  stage: ChildProgressStage;
  work?: { unit: "windows"; completed: number; total: number };
}

export function parseChildProgress(
  value: Record<string, unknown>,
): ChildProgress | null {
  if (
    typeof value.stage !== "string" ||
    !CHILD_PROGRESS_STAGES.includes(value.stage as ChildProgressStage)
  )
    return null;
  const keys = Object.keys(value);
  if (
    keys.some((key) => !["stage", "unit", "completed", "total"].includes(key))
  )
    return null;
  if (keys.length === 1) return { stage: value.stage as ChildProgressStage };
  if (
    keys.length !== 4 ||
    value.stage !== "separation" ||
    value.unit !== "windows" ||
    !Number.isSafeInteger(value.completed) ||
    !Number.isSafeInteger(value.total) ||
    (value.completed as number) < 0 ||
    (value.total as number) < 1 ||
    (value.completed as number) > (value.total as number) ||
    (value.total as number) > 1_000_000
  )
    return null;
  return {
    stage: "separation",
    work: {
      unit: "windows",
      completed: value.completed as number,
      total: value.total as number,
    },
  };
}
