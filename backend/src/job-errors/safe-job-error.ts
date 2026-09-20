import type { JobFailureCode } from '../jobs/job.types.js';
import { safeJobFailureMessage } from '../jobs/job-lifecycle-policy.js';

export function safeJobMessage(code: JobFailureCode): string {
  return safeJobFailureMessage(code);
}
