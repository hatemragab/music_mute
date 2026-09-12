import type { JobFailureCode } from '../jobs/job.types.js';

const messages: Record<JobFailureCode, string> = {
  UPLOAD_EXPIRED: 'The upload reservation expired before it was completed.',
  INVALID_AUDIO: 'The file does not contain supported playable audio.',
  INPUT_TOO_LONG: 'Audio must be shorter than 10 minutes.',
  INPUT_CHECKSUM_MISMATCH: 'The audio file failed its integrity check.',
  SEPARATOR_FAILED: 'Voice separation failed. You can retry this job.',
  OUTPUT_INVALID: 'The voice-only result could not be validated.',
  DOWNLOAD_FAILED: 'The worker could not download the audio.',
  OUTPUT_UPLOAD_FAILED: 'The worker could not upload the result.',
};
export function safeJobMessage(code: JobFailureCode): string {
  return messages[code];
}
