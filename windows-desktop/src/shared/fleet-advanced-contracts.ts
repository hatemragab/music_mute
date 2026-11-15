export type FleetAdvancedRead =
  | "versions"
  | "status"
  | "doctor"
  | "logs"
  | "job"
  | "errors"
  | "explain"
  | "performance"
  | "capacity";
export interface FleetAdvancedFilter {
  lines?: number;
  last?: number;
  since?: string;
  level?: "info" | "warning" | "error";
  errorsOnly?: boolean;
  jobId?: string;
  attemptId?: string;
  code?: string;
  recipe?: "kim-vocals-v2" | "kim-vocals-v2-trim";
  full?: boolean;
  follow?: boolean;
}
export type FleetAdvancedMutation =
  | {
      action:
        | "cleanup"
        | "clear_logs"
        | "benchmark_capacity"
        | "remove"
        | "restore"
        | "purge";
    }
  | { action: "stop" | "restart"; force: true }
  | { action: "revoke"; force?: boolean }
  | { action: "update"; force?: boolean; source?: "app" | "catalog" }
  | { action: "capacity"; workers: 1 | 2 }
  | {
      action: "benchmark_file";
      inputCapability: string;
      recipe: "kim-vocals-v2" | "kim-vocals-v2-trim";
      warmupRuns: number;
      measuredRuns: number;
      rightsConfirmed: true;
      groupSize?: 1;
      candidateRelease?: string;
      baselineCapability?: string;
      saveAudio?: boolean;
      audioDestinationCapability?: string;
      reportDestinationCapability?: string;
    };
export type FleetAdvancedCommand =
  | { type: "READ"; section: FleetAdvancedRead; filter?: FleetAdvancedFilter }
  | { type: "CLEANUP_PREVIEW" | "CANCEL" | "RECOVER" }
  | { type: "UPDATE_CHECK"; source?: "app" | "catalog" }
  | { type: "CONFIRM"; mutation: FleetAdvancedMutation }
  | { type: "RUN"; confirmation: string }
  | { type: "EXPORT"; destinationCapability: string };
export interface FleetAdvancedView {
  phase:
    | "idle"
    | "loading"
    | "confirmation"
    | "waiting"
    | "running"
    | "complete"
    | "recovery"
    | "error";
  machineId: string | null;
  section: FleetAdvancedRead | "cleanup" | "update" | "operation" | null;
  data: unknown;
  confirmation: {
    token: string;
    action: FleetAdvancedMutation["action"];
    expiresAt: string;
    force?: boolean;
    source?: "app" | "catalog";
  } | null;
  problem: string | null;
  cancellable: boolean;
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("ADVANCED_REQUEST_INVALID");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("ADVANCED_REQUEST_INVALID");
}
export function parseFleetAdvancedMutation(
  value: unknown,
): FleetAdvancedMutation {
  const v = row(value);
  if (
    [
      "cleanup",
      "clear_logs",
      "benchmark_capacity",
      "remove",
      "restore",
      "purge",
    ].includes(String(v.action))
  )
    exact(v, ["action"]);
  else if (["stop", "restart", "revoke", "update"].includes(String(v.action))) {
    exact(
      v,
      v.action === "update"
        ? ["action", "force", "source"]
        : ["action", "force"],
    );
    if (
      (["stop", "restart"].includes(String(v.action)) && v.force !== true) ||
      (Object.hasOwn(v, "force") && typeof v.force !== "boolean") ||
      (Object.hasOwn(v, "source") &&
        v.source !== "app" &&
        v.source !== "catalog")
    )
      throw new Error("ADVANCED_REQUEST_INVALID");
  } else if (v.action === "capacity") {
    exact(v, ["action", "workers"]);
    if (v.workers !== 1 && v.workers !== 2)
      throw new Error("ADVANCED_REQUEST_INVALID");
  } else if (v.action === "benchmark_file") {
    exact(v, [
      "action",
      "inputCapability",
      "recipe",
      "warmupRuns",
      "measuredRuns",
      "rightsConfirmed",
      "groupSize",
      "candidateRelease",
      "baselineCapability",
      "saveAudio",
      "audioDestinationCapability",
      "reportDestinationCapability",
    ]);
    if (
      typeof v.inputCapability !== "string" ||
      !UUID.test(v.inputCapability) ||
      !["kim-vocals-v2", "kim-vocals-v2-trim"].includes(String(v.recipe)) ||
      !Number.isInteger(v.warmupRuns) ||
      Number(v.warmupRuns) < 0 ||
      Number(v.warmupRuns) > 2 ||
      !Number.isInteger(v.measuredRuns) ||
      Number(v.measuredRuns) < 3 ||
      Number(v.measuredRuns) > 10 ||
      v.rightsConfirmed !== true
    )
      throw new Error("ADVANCED_REQUEST_INVALID");
    if (
      (v.groupSize !== undefined && v.groupSize !== 1) ||
      (v.candidateRelease !== undefined &&
        (typeof v.candidateRelease !== "string" ||
          !/^[a-f0-9]{64}$/u.test(v.candidateRelease))) ||
      (v.saveAudio !== undefined && typeof v.saveAudio !== "boolean") ||
      [
        "baselineCapability",
        "audioDestinationCapability",
        "reportDestinationCapability",
      ].some(
        (key) =>
          v[key] !== undefined &&
          (typeof v[key] !== "string" || !UUID.test(v[key] as string)),
      ) ||
      (v.saveAudio === true) !== (v.audioDestinationCapability !== undefined)
    )
      throw new Error("ADVANCED_REQUEST_INVALID");
  } else throw new Error("ADVANCED_REQUEST_INVALID");
  return structuredClone(v) as unknown as FleetAdvancedMutation;
}
export function parseFleetAdvancedCommand(
  value: unknown,
): FleetAdvancedCommand {
  const v = row(value);
  if (["CLEANUP_PREVIEW", "CANCEL", "RECOVER"].includes(String(v.type)))
    exact(v, ["type"]);
  else if (v.type === "UPDATE_CHECK") {
    exact(v, ["type", "source"]);
    if (
      Object.hasOwn(v, "source") &&
      v.source !== "app" &&
      v.source !== "catalog"
    )
      throw new Error("ADVANCED_REQUEST_INVALID");
  } else if (v.type === "RUN" || v.type === "EXPORT") {
    const key = v.type === "RUN" ? "confirmation" : "destinationCapability";
    exact(v, ["type", key]);
    if (typeof v[key] !== "string" || !UUID.test(v[key]))
      throw new Error("ADVANCED_REQUEST_INVALID");
  } else if (v.type === "CONFIRM") {
    exact(v, ["type", "mutation"]);
    v.mutation = parseFleetAdvancedMutation(v.mutation);
  } else if (v.type === "READ") {
    exact(v, ["type", "section", "filter"]);
    if (
      ![
        "versions",
        "status",
        "doctor",
        "logs",
        "job",
        "errors",
        "explain",
        "performance",
        "capacity",
      ].includes(String(v.section))
    )
      throw new Error("ADVANCED_REQUEST_INVALID");
    if (v.filter !== undefined) {
      const f = row(v.filter);
      const allowed: Record<FleetAdvancedRead, string[]> = {
        versions: [],
        status: [],
        capacity: [],
        doctor: ["full"],
        logs: [
          "follow",
          "lines",
          "since",
          "level",
          "errorsOnly",
          "jobId",
          "attemptId",
          "code",
        ],
        job: ["jobId", "since"],
        errors: ["since", "last"],
        explain: ["code", "since"],
        performance: ["since", "last", "jobId", "recipe"],
      };
      exact(f, allowed[v.section as FleetAdvancedRead]);
      for (const [key, entry] of Object.entries(f)) {
        if (
          ["lines", "last"].includes(key)
            ? !Number.isInteger(entry) ||
              Number(entry) < 1 ||
              Number(entry) > (key === "lines" ? 1000 : 100)
            : key === "since"
              ? typeof entry !== "string" ||
                !/^\d{1,7}[smhd]$/u.test(entry) ||
                Number(entry.slice(0, -1)) < 1
              : ["full", "errorsOnly", "follow"].includes(key)
                ? typeof entry !== "boolean"
                : key === "level"
                  ? !["info", "warning", "error"].includes(String(entry))
                  : key === "jobId"
                    ? typeof entry !== "string" ||
                      !/^[a-f0-9]{24}$/iu.test(entry)
                    : key === "attemptId"
                      ? typeof entry !== "string" || !UUID.test(entry)
                      : key === "code"
                        ? typeof entry !== "string" ||
                          !/^[A-Za-z0-9_-]{1,100}$/u.test(entry)
                        : key === "recipe"
                          ? !["kim-vocals-v2", "kim-vocals-v2-trim"].includes(
                              String(entry),
                            )
                          : true
        )
          throw new Error("ADVANCED_REQUEST_INVALID");
      }
    }
    const f = v.filter as FleetAdvancedFilter | undefined;
    if (
      (v.section === "job" && !f?.jobId) ||
      (v.section === "explain" && !f?.code)
    )
      throw new Error("ADVANCED_REQUEST_INVALID");
  } else throw new Error("ADVANCED_REQUEST_INVALID");
  return structuredClone(v) as unknown as FleetAdvancedCommand;
}
