import { jobError } from '../jobs/job-errors.js';
export interface QueueCostModel {
  revision: string;
  evidenceStatus: 'verified' | 'unavailable' | 'stale';
  referenceProcessingSecondsPerAudioSecond: number;
  fixedJobOverheadSeconds: number;
  measuredAt: string;
}
export function estimateCost(duration: number, model: QueueCostModel): number {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !model.revision ||
    model.evidenceStatus !== 'verified' ||
    !Number.isFinite(Date.parse(model.measuredAt)) ||
    !Number.isFinite(model.referenceProcessingSecondsPerAudioSecond) ||
    model.referenceProcessingSecondsPerAudioSecond <= 0 ||
    !Number.isFinite(model.fixedJobOverheadSeconds) ||
    model.fixedJobOverheadSeconds < 0
  )
    throw jobError('PROCESSING_CAPACITY_UNAVAILABLE');
  const cost = Math.ceil(
    duration * model.referenceProcessingSecondsPerAudioSecond +
      model.fixedJobOverheadSeconds,
  );
  if (!Number.isSafeInteger(cost) || cost <= 0)
    throw jobError('PROCESSING_CAPACITY_UNAVAILABLE');
  return cost;
}
