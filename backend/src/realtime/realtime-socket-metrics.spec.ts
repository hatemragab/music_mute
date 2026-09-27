import { expect, it } from 'vitest';
import { RealtimeSocketMetrics } from './realtime-socket-metrics.js';

it('reports and resets aggregate socket metrics without request identity data', () => {
  const metrics = new RealtimeSocketMetrics();
  metrics.accepted();
  metrics.rejected(401);
  metrics.rejected(429);
  metrics.rejected(503);
  metrics.closed(1000);
  metrics.closed(1008);
  metrics.closed(4001);
  metrics.closed(1013);
  metrics.closed(1006);
  metrics.read(10.4, false);
  metrics.read(21.6, true);
  metrics.sent(120, 40, true);
  metrics.sent(20, 80, false);

  expect(metrics.drain(3)).toEqual({
    event: 'realtime_socket_metrics',
    activeConnections: 3,
    accepted: 1,
    rejected: { unauthorized: 1, rateLimited: 1, unavailable: 1 },
    closed: { normal: 1, policy: 1, session: 1, capacity: 1, other: 1 },
    reads: 2,
    readFailures: 1,
    averageReadMs: 16,
    maxReadMs: 22,
    snapshots: 1,
    frames: 2,
    outboundBytes: 140,
    maxBufferedBytes: 80,
  });
  expect(metrics.drain(0)).toMatchObject({
    activeConnections: 0,
    accepted: 0,
    reads: 0,
    frames: 0,
  });
});
