import { expect, it } from 'vitest';
import { parseRealtimeCommand } from './realtime-protocol.js';

it('accepts bounded subscriptions, resets and heartbeat replies', () => {
  expect(
    parseRealtimeCommand(
      '{"type":"subscribe","subscription_id":"jobs-1","resource":"jobs"}',
    ),
  ).toEqual({
    type: 'subscribe',
    subscription_id: 'jobs-1',
    resource: 'jobs',
    params: {},
  });
  expect(
    parseRealtimeCommand('{"type":"resync","subscription_id":"jobs-1"}'),
  )?.toEqual({ type: 'resync', subscription_id: 'jobs-1' });
  expect(parseRealtimeCommand('{"type":"pong"}')).toEqual({ type: 'pong' });
});

it.each([
  'null',
  '[]',
  '{',
  '{"type":"pong","token":"secret"}',
  '{"type":"subscribe","subscription_id":"jobs","resource":"/admin/secrets"}',
  '{"type":"subscribe","subscription_id":"jobs","resource":"jobs","params":{"filter":{"$gt":0}}}',
  '{"type":"subscribe","subscription_id":"jobs","resource":"jobs","params":{"__proto__":"bad"}}',
  '{"type":"unsubscribe","subscription_id":"jobs","resource":"jobs"}',
  JSON.stringify({
    type: 'subscribe',
    subscription_id: 'jobs',
    resource: 'jobs',
    params: { cursor: 'x'.repeat(2049) },
  }),
  ' '.repeat(8193),
])('rejects malformed or excessive control frames', (raw) => {
  expect(parseRealtimeCommand(raw)).toBeNull();
});
