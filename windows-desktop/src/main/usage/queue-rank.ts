import { parseResetTimestamp } from "./presentation.js";
export interface QueueRank {
  position: number;
  jobsAhead: number;
  scope: "recipe";
  asOf: string;
}
export function queueRank(job: unknown, live: boolean): QueueRank | null {
  if (!live || !job || typeof job !== "object" || Array.isArray(job))
    return null;
  const source = job as Record<string, unknown>;
  const queue = source.queue;
  if (
    source.status !== "queued" ||
    !queue ||
    typeof queue !== "object" ||
    Array.isArray(queue)
  )
    return null;
  const value = queue as Record<string, unknown>;
  if (
    value.state !== "waiting" ||
    value.scope !== "recipe" ||
    value.reason !== null ||
    typeof value.position !== "number" ||
    !Number.isSafeInteger(value.position) ||
    value.position < 1 ||
    value.position > 5000 ||
    value.jobs_ahead !== value.position - 1
  )
    return null;
  try {
    return {
      position: value.position,
      jobsAhead: value.position - 1,
      scope: "recipe",
      asOf: parseResetTimestamp(value.as_of),
    };
  } catch {
    return null;
  }
}
/** Cached rows can remain visible offline; their queue numbers cannot. */
export function hideStaleQueueRanks(data: unknown): unknown {
  const cloned: unknown = structuredClone(data);
  let visited = 0;
  const walk = (value: unknown, depth: number): void => {
    if (++visited > 20000 || depth > 32)
      throw new TypeError("REALTIME_DATA_TOO_LARGE");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      record.queue &&
      typeof record.queue === "object" &&
      !Array.isArray(record.queue)
    ) {
      const queue = record.queue as Record<string, unknown>;
      queue.position = null;
      queue.jobs_ahead = null;
    }
    if (Object.hasOwn(record, "queue_position")) record.queue_position = null;
    for (const child of Object.values(record)) walk(child, depth + 1);
  };
  walk(cloned, 0);
  return cloned;
}
