import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startAudioProcessingFixture } from './helpers/audio-processing-fixture.mjs';

test('lost claim replies can recover only the persisted installation session', async (t) => {
  const f = await startAudioProcessingFixture(t);
  const created = await f.request('POST', '/jobs', {
    requestId: randomUUID(),
    input: {
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 100,
      durationSeconds: 10,
      sha256: Buffer.alloc(32).toString('base64'),
    },
  });
  assert.equal(created.status, 201);
  f.fakeStorage.put((await f.jobs.findById(created.body.id)).inputReservation);
  assert.equal(
    (await f.request('POST', `/jobs/${created.body.id}/upload-complete`, {}))
      .status,
    200,
  );
  const sessionId = randomUUID();
  const claimed = await f.request(
    'POST',
    '/worker/claim',
    { sessionId },
    'worker',
  );
  assert.equal(claimed.status, 200);
  // The worker can crash before it receives/saves this assignment. Only its
  // pre-request session identity is durable when it boots again.
  await f.jobs.updateOne(
    { _id: created.body.id },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  await f.control.updateOne(
    { _id: f.workerId },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  const foreign = await f.request(
    'POST',
    '/worker/claim',
    { sessionId: randomUUID() },
    'worker',
  );
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body.canRecover, false);
  const own = await f.request('POST', '/worker/claim', { sessionId }, 'worker');
  assert.equal(own.status, 409);
  assert.equal(own.body.canRecover, true);
  assert.equal(own.body.previousAttemptId, claimed.body.attemptId);
  const resumed = await f.request(
    'POST',
    '/worker/reconcile',
    {
      sessionId,
      previousAttemptId: own.body.previousAttemptId,
      stopped: true,
    },
    'worker',
  );
  assert.equal(resumed.status, 200);
  assert.ok(resumed.body.generation > claimed.body.generation);
  const { jobId, attemptId, generation } = claimed.body;
  assert.equal(
    (
      await f.request(
        'POST',
        '/worker/heartbeat',
        { jobId, sessionId, attemptId, generation },
        'worker',
      )
    ).status,
    409,
  );
});
