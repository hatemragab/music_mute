import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startAudioProcessingFixture } from './helpers/audio-processing-fixture.mjs';

test('cancellation during output verification wins and offline cancellation waits for stopped recovery', async (t) => {
  const f = await startAudioProcessingFixture(t);
  const input = {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 100,
    durationSeconds: 10,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  const created = await f.request('POST', '/jobs', {
    requestId: randomUUID(),
    input,
  });
  f.fakeStorage.put((await f.jobs.findById(created.body.id)).inputReservation);
  await f.request('POST', `/jobs/${created.body.id}/upload-complete`, {});
  const claim = await f.request(
    'POST',
    '/worker/claim',
    { sessionId: randomUUID() },
    'worker',
  );
  const { jobId, attemptId, sessionId, generation } = claim.body;
  const selector = { jobId, attemptId, sessionId, generation };
  await f.request(
    'POST',
    '/worker/stage',
    {
      ...selector,
      eventId: randomUUID(),
      stage: 'processing',
      durationSeconds: 10,
      decodable: true,
      hasAudio: true,
    },
    'worker',
  );
  const output = await f.request(
    'POST',
    '/worker/output-url',
    {
      ...selector,
      eventId: randomUUID(),
      bytes: 90,
      durationSeconds: 10,
      sha256: input.sha256,
      contentType: 'audio/mpeg',
      playable: true,
      voiceOnly: true,
    },
    'worker',
  );
  assert.equal(output.status, 200);
  f.fakeStorage.put((await f.jobs.findById(jobId)).outputReservation);
  const verify = f.fakeStorage.providers.transfers.verifyOutput;
  f.fakeStorage.providers.transfers.verifyOutput = async (job) => {
    const cancellation = await f.request('POST', `/jobs/${jobId}/cancel`, {});
    assert.equal(cancellation.body.status, 'cancel_requested');
    return verify(job);
  };
  const result = await f.request(
    'POST',
    '/worker/complete',
    { ...selector, eventId: randomUUID() },
    'worker',
  );
  assert.equal(result.status, 409);
  assert.equal((await f.jobs.findById(jobId)).status, 'cancel_requested');
  assert.equal(await f.jobs.db.model('NotificationOutbox').countDocuments(), 0);
  await f.jobs.updateOne(
    { _id: jobId },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  await f.control.updateOne(
    { _id: f.workerId },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  assert.equal(
    (
      await f.request(
        'POST',
        '/worker/cancelled',
        { ...selector, eventId: randomUUID(), stopped: true },
        'worker',
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.control.findById(f.workerId)).activeJobId.toString(),
    jobId,
  );
  const recovery = {
    sessionId: randomUUID(),
    previousAttemptId: attemptId,
    stopped: true,
  };
  const final = await f.request(
    'POST',
    '/worker/reconcile',
    recovery,
    'worker',
  );
  assert.equal(final.body.status, 'cancelled');
  assert.equal((await f.control.findById(f.workerId)).activeJobId, null);
  assert.equal((await f.jobs.findById(jobId)).outputObject, null);
  assert.equal(f.fakeStorage.objects.size, 2);
});
