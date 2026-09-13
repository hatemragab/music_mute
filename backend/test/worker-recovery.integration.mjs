import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startAudioProcessingFixture } from './helpers/audio-processing-fixture.mjs';

test('expired worker holds slot across restart and reconciliation resumes the same job', async (t) => {
  const f = await startAudioProcessingFixture(t);
  const input = {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 100,
    durationSeconds: 10,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  const create = async (identity = 'owner') => {
    const response = await f.request(
      'POST',
      '/jobs',
      {
        requestId: randomUUID(),
        input,
      },
      identity,
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    f.fakeStorage.put(
      (await f.jobs.findById(response.body.id)).inputReservation,
    );
    assert.equal(
      (
        await f.request(
          'POST',
          `/jobs/${response.body.id}/upload-complete`,
          {},
          identity,
        )
      ).status,
      200,
    );
    return response.body.id;
  };
  const first = await create();
  await create('other');
  const claim = await f.request(
    'POST',
    '/worker/claim',
    { sessionId: randomUUID() },
    'worker',
  );
  assert.equal(claim.status, 200);
  const { jobId, attemptId, sessionId, generation } = claim.body;
  const selector = { jobId, attemptId, sessionId, generation };
  assert.equal(jobId, first);
  await f.jobs.updateOne(
    { _id: first },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  await f.control.updateOne(
    { _id: 'z440' },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  await f.restartApi();
  assert.equal((await f.jobs.findById(first)).status, 'interrupted');
  assert.equal(
    (await f.control.findById('z440')).activeJobId.toString(),
    first,
  );
  assert.equal(
    (await f.request('POST', '/worker/heartbeat', selector, 'worker')).status,
    409,
  );
  assert.equal(
    (
      await f.request(
        'POST',
        '/worker/claim',
        { sessionId: randomUUID() },
        'worker',
      )
    ).status,
    409,
  );
  const recovery = {
    sessionId: randomUUID(),
    previousAttemptId: attemptId,
    stopped: true,
  };
  const [resumed, concurrent] = await Promise.all([
    f.request('POST', '/worker/reconcile', recovery, 'worker'),
    f.request('POST', '/worker/reconcile', recovery, 'worker'),
  ]);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(concurrent.status, 200, JSON.stringify(concurrent.body));
  assert.equal(concurrent.body.attemptId, resumed.body.attemptId);
  assert.equal(resumed.body.jobId, first);
  assert.notEqual(resumed.body.attemptId, attemptId);
  assert.ok(resumed.body.generation > generation);
  const repeat = await f.request(
    'POST',
    '/worker/reconcile',
    recovery,
    'worker',
  );
  assert.equal(repeat.body.attemptId, resumed.body.attemptId);
  await f.jobs.updateOne(
    { _id: first },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  await f.control.updateOne(
    { _id: 'z440' },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  const lostResponse = await f.request(
    'POST',
    '/worker/reconcile',
    recovery,
    'worker',
  );
  assert.equal(lostResponse.status, 409);
  assert.equal(lostResponse.body.code, 'WORKER_RECOVERY_REQUIRED');
  assert.equal(lostResponse.body.previousAttemptId, resumed.body.attemptId);
  assert.equal(await f.attempts.countDocuments(), 2);
  assert.equal(
    await f.errors.countDocuments({ classification: 'interruption' }),
    1,
  );
  assert.equal(await f.jobs.countDocuments({ status: 'queued' }), 1);
  const nextRecovery = {
    ...recovery,
    previousAttemptId: lostResponse.body.previousAttemptId,
  };
  const third = await f.request(
    'POST',
    '/worker/reconcile',
    nextRecovery,
    'worker',
  );
  assert.equal(third.status, 200, JSON.stringify(third.body));
  const failure = {
    jobId: third.body.jobId,
    sessionId: third.body.sessionId,
    attemptId: third.body.attemptId,
    generation: third.body.generation,
    eventId: randomUUID(),
    stopped: true,
    stage: 'validating',
    code: 'SEPARATOR_FAILED',
  };
  assert.equal(
    (await f.request('POST', '/worker/fail', failure, 'worker')).body.status,
    'failed',
  );
  const terminalReplay = await f.request(
    'POST',
    '/worker/reconcile',
    nextRecovery,
    'worker',
  );
  assert.equal(terminalReplay.status, 200);
  assert.equal(terminalReplay.body.status, 'failed');
});
