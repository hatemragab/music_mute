export interface OverviewSnapshot {
  asOf: string;
  from: string;
  to: string;
  counts: {
    submitted: number;
    completed: number;
    failed: number;
    cancelled: number;
    processingActiveUsers: number;
  };
  queue: {
    waiting: number;
    processing: number;
    oldestWaitSeconds: number | null;
  };
  timings: {
    meanQueueWaitSeconds: number | null;
    meanProcessingSeconds: number | null;
    sampleCount: { queueWait: number; processing: number };
  };
  series: {
    start: string;
    submitted: number;
    completed: number;
    failed: number;
    cancelled: number;
  }[];
  releaseSummary?: {
    draft: number;
    published: number;
    withdrawn: number;
    rejectedArtifacts: number;
  };
}
