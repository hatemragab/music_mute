interface MetricCounts {
  accepted: number;
  rejected401: number;
  rejected429: number;
  rejected503: number;
  closedNormal: number;
  closedPolicy: number;
  closedSession: number;
  closedCapacity: number;
  closedOther: number;
  reads: number;
  readFailures: number;
  snapshots: number;
  frames: number;
  outboundBytes: number;
  maxBufferedBytes: number;
  totalReadMs: number;
  maxReadMs: number;
}

const emptyCounts = (): MetricCounts => ({
  accepted: 0,
  rejected401: 0,
  rejected429: 0,
  rejected503: 0,
  closedNormal: 0,
  closedPolicy: 0,
  closedSession: 0,
  closedCapacity: 0,
  closedOther: 0,
  reads: 0,
  readFailures: 0,
  snapshots: 0,
  frames: 0,
  outboundBytes: 0,
  maxBufferedBytes: 0,
  totalReadMs: 0,
  maxReadMs: 0,
});

/** Aggregate-only operational telemetry. Never records identities, resources or payloads. */
export class RealtimeSocketMetrics {
  private counts = emptyCounts();

  accepted(): void {
    this.counts.accepted++;
  }

  rejected(status: number): void {
    if (status === 401) this.counts.rejected401++;
    else if (status === 429) this.counts.rejected429++;
    else this.counts.rejected503++;
  }

  closed(code: number): void {
    if (code === 1000 || code === 1001 || code === 1005)
      this.counts.closedNormal++;
    else if (code === 1008) this.counts.closedPolicy++;
    else if (code === 4001) this.counts.closedSession++;
    else if (code === 1013) this.counts.closedCapacity++;
    else this.counts.closedOther++;
  }

  read(durationMs: number, failed: boolean): void {
    const duration = Math.max(0, Math.round(durationMs));
    this.counts.reads++;
    if (failed) this.counts.readFailures++;
    this.counts.totalReadMs += duration;
    this.counts.maxReadMs = Math.max(this.counts.maxReadMs, duration);
  }

  sent(bytes: number, bufferedBytes: number, snapshot: boolean): void {
    this.counts.frames++;
    if (snapshot) this.counts.snapshots++;
    this.counts.outboundBytes += bytes;
    this.counts.maxBufferedBytes = Math.max(
      this.counts.maxBufferedBytes,
      bufferedBytes,
    );
  }

  drain(activeConnections: number) {
    const counts = this.counts;
    this.counts = emptyCounts();
    return {
      event: 'realtime_socket_metrics',
      activeConnections,
      accepted: counts.accepted,
      rejected: {
        unauthorized: counts.rejected401,
        rateLimited: counts.rejected429,
        unavailable: counts.rejected503,
      },
      closed: {
        normal: counts.closedNormal,
        policy: counts.closedPolicy,
        session: counts.closedSession,
        capacity: counts.closedCapacity,
        other: counts.closedOther,
      },
      reads: counts.reads,
      readFailures: counts.readFailures,
      averageReadMs:
        counts.reads > 0 ? Math.round(counts.totalReadMs / counts.reads) : 0,
      maxReadMs: counts.maxReadMs,
      snapshots: counts.snapshots,
      frames: counts.frames,
      outboundBytes: counts.outboundBytes,
      maxBufferedBytes: counts.maxBufferedBytes,
    };
  }
}
