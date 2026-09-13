import type {
  ProcessingPolicyV2,
  ProcessingQualification,
} from "@/api/contracts";
export type Draft = Omit<
  ProcessingPolicyV2,
  "revision" | "updatedAt" | "readiness" | "shortLongThresholdSeconds"
>;

export const policyFields = [
  [
    "maxDurationSeconds",
    "Maximum audio duration (minutes, inclusive)",
    60,
    1,
    1800,
  ],
  [
    "maxPreparedAudioBytes",
    "Maximum prepared audio (decimal MB, inclusive)",
    1_000_000,
    1,
    100_000_000,
  ],
  [
    "allowanceAudioSeconds",
    "Rolling account allowance (audio minutes)",
    60,
    3600,
    86400,
  ],
  ["maxOutstandingJobs", "Maximum outstanding jobs", 1, 1, 1000],
  [
    "maxOutstandingAudioSeconds",
    "Maximum outstanding audio (minutes)",
    60,
    1,
    1_800_000,
  ],
  ["agingThresholdSeconds", "Fairness aging threshold (minutes)", 60, 1, 86400],
] as const;
export const qualificationNumbers = [
  ["maxLocalSourceBytes", "Local source ceiling (bytes)", 1, 20_000_000_000],
  [
    "maxSourceDownloadBytes",
    "Source download ceiling (bytes)",
    1,
    2_000_000_000,
  ],
  ["maxPreparationSeconds", "Preparation deadline (seconds)", 1, 86400],
  ["maxSourceDownloadSeconds", "Source download deadline (seconds)", 1, 86400],
  ["maxOutputBytes", "Prepared result ceiling (bytes)", 1, 100_000_000],
  ["probeTimeoutSeconds", "Probe deadline (seconds)", 1, 3600],
  ["processingTimeoutSeconds", "Processing deadline (seconds)", 1, 86400],
  [
    "maxOutstandingEstimatedWorkerSeconds",
    "Outstanding estimated worker budget (seconds)",
    1,
    86_400_000,
  ],
  [
    "referenceProcessingSecondsPerAudioSecond",
    "Measured worker seconds per audio second",
    Number.MIN_VALUE,
    1000,
  ],
  ["fixedJobOverheadSeconds", "Measured fixed overhead (seconds)", 0, 3600],
] as const;
export const emptyQualification: ProcessingQualification = {
  evidenceReference: "",
  compatibilityRevision: "",
  measuredAt: "",
  expiresAt: "",
  qualifiedWorkerIds: [],
  maxLocalSourceBytes: NaN,
  maxSourceDownloadBytes: NaN,
  maxPreparationSeconds: NaN,
  maxSourceDownloadSeconds: NaN,
  maxOutputBytes: NaN,
  probeTimeoutSeconds: NaN,
  processingTimeoutSeconds: NaN,
  maxOutstandingEstimatedWorkerSeconds: NaN,
  costModelRevision: "",
  referenceProcessingSecondsPerAudioSecond: NaN,
  fixedJobOverheadSeconds: NaN,
};
export function validatePolicyDraft(
  value: Draft,
  now = new Date(),
  preservedQualification?: ProcessingQualification | null,
) {
  const errors: string[] = [];
  for (const [key, label, , min, max] of policyFields)
    if (
      !Number.isSafeInteger(value[key]) ||
      value[key] < min ||
      value[key] > max
    )
      errors.push(`${label} is outside the supported range.`);
  if (
    value.maxActiveJobsPerUser !== 1 ||
    value.allowanceWindowSeconds !== 86400
  )
    errors.push(
      "One unfinished job and a 24-hour rolling window are required.",
    );
  const q = value.qualification;
  if (q) {
    for (const [key, label, min, max] of qualificationNumbers) {
      if (
        !Number.isFinite(q[key]) ||
        q[key] < min ||
        q[key] > max ||
        (![
          "referenceProcessingSecondsPerAudioSecond",
          "fixedJobOverheadSeconds",
        ].includes(key) &&
          !Number.isSafeInteger(q[key]))
      )
        errors.push(
          `${label} requires measured evidence within its allowed range.`,
        );
    }
    for (const key of [
      "evidenceReference",
      "compatibilityRevision",
      "costModelRevision",
    ] as const)
      if (!q[key].trim() || q[key].length > 200)
        errors.push(`${key} is required (up to 200 characters).`);
    const measured = Date.parse(q.measuredAt),
      expires = Date.parse(q.expiresAt);
    if (
      !Number.isFinite(measured) ||
      measured > now.getTime() + 5000 ||
      !Number.isFinite(expires) ||
      (expires <= now.getTime() &&
        JSON.stringify(q) !== JSON.stringify(preservedQualification)) ||
      expires <= measured ||
      expires - measured > 30 * 86400_000
    )
      errors.push(
        "Qualification requires a past measurement and a future expiry within 30 days of measurement.",
      );
    if (
      !q.qualifiedWorkerIds.length ||
      q.qualifiedWorkerIds.length > 100 ||
      new Set(q.qualifiedWorkerIds).size !== q.qualifiedWorkerIds.length ||
      q.qualifiedWorkerIds.some((id) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    )
      errors.push("Provide unique qualified worker IDs (1–100).");
  }
  return errors;
}
