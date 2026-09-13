import { jobError } from '../jobs/job-errors.js';
export interface AttemptExecutionEvidence {
  eventId: string;
  separatorExecutionSeconds: number;
  processingStartedAt: string;
  measuredAudioSeconds: number;
  stoppedConfirmed: boolean;
  separationCompleted?: boolean;
}
export function assertExecutionEvidence(
  evidence: AttemptExecutionEvidence,
  eventId: string,
  previous: number | null,
  start: Date,
  now: Date,
): void {
  const reportedStart = Date.parse(evidence.processingStartedAt);
  if (
    evidence.eventId !== eventId ||
    !Number.isFinite(evidence.separatorExecutionSeconds) ||
    evidence.separatorExecutionSeconds < 0 ||
    evidence.separatorExecutionSeconds < (previous ?? 0) ||
    evidence.separatorExecutionSeconds >
      Math.max(0, (now.getTime() - start.getTime()) / 1000) + 1 ||
    !Number.isFinite(reportedStart) ||
    reportedStart < start.getTime() - 5000 ||
    reportedStart > now.getTime() + 5000 ||
    !Number.isFinite(evidence.measuredAudioSeconds) ||
    evidence.measuredAudioSeconds <= 0 ||
    evidence.measuredAudioSeconds > 1800 ||
    typeof evidence.stoppedConfirmed !== 'boolean' ||
    (evidence.separationCompleted !== undefined &&
      typeof evidence.separationCompleted !== 'boolean')
  )
    throw jobError('JOB_STATE_CONFLICT');
}
