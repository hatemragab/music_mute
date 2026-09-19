import { PREPARATION_PROFILE_ID, type InputSource } from './job.types.js';
import { jobError } from './job-errors.js';
import { authError } from '../auth/auth.errors.js';

export const AUDIO_NAME_PATTERN = /^[^\p{Cc}]+$/u;
export const YOUTUBE_SOURCE_URL_PATTERN =
  /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/;
export interface JobMetadata {
  policyVersion?: 2;
  preparationProfileId?: string;
  source?: InputSource;
  sourceTitle?: string;
  sourceKind?: 'url' | 'file';
  sourceUrl?: string;
  clientStartedAt?: string;
}

export function isAudioName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    [...value].length <= 200 &&
    AUDIO_NAME_PATTERN.test(value)
  );
}

export function normalizeAudioName(value: unknown): string {
  if (typeof value !== 'string') throw authError('INVALID_INPUT');
  const name = value.trim();
  if (!isAudioName(name)) throw authError('INVALID_INPUT');
  return name;
}

export function normalizeYouTubeSourceUrl(value: unknown): string {
  if (typeof value !== 'string') throw authError('INVALID_INPUT');
  const url = value.trim();
  if (!YOUTUBE_SOURCE_URL_PATTERN.test(url)) throw authError('INVALID_INPUT');
  return url;
}

export function normalizeJobMetadata(metadata: JobMetadata): JobMetadata {
  const result: JobMetadata = {};
  if (
    metadata.policyVersion !== 2 ||
    metadata.preparationProfileId !== PREPARATION_PROFILE_ID ||
    !['audio_file', 'video_file', 'youtube'].includes(metadata.source ?? '')
  )
    throw jobError('PROCESSING_POLICY_INCOMPATIBLE');
  result.policyVersion = 2;
  result.preparationProfileId = metadata.preparationProfileId;
  result.source = metadata.source;
  if (metadata.sourceTitle !== undefined)
    result.sourceTitle = normalizeAudioName(metadata.sourceTitle);
  if (metadata.sourceKind !== undefined) {
    if (!['url', 'file'].includes(metadata.sourceKind))
      throw authError('INVALID_INPUT');
    result.sourceKind = metadata.sourceKind;
  }
  if (metadata.sourceUrl !== undefined) {
    if (result.sourceKind !== 'url') throw authError('INVALID_INPUT');
    result.sourceUrl = normalizeYouTubeSourceUrl(metadata.sourceUrl);
  }
  if (metadata.clientStartedAt !== undefined) {
    if (
      typeof metadata.clientStartedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(
        metadata.clientStartedAt,
      ) ||
      !Number.isFinite(Date.parse(metadata.clientStartedAt))
    )
      throw authError('INVALID_INPUT');
    result.clientStartedAt = new Date(metadata.clientStartedAt).toISOString();
  }
  return result;
}
