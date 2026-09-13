import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startAudioProcessingFixture } from './helpers/audio-processing-fixture.mjs';

test('HTTP uploads, private history and stable pagination survive API restart', async (t) => {
  const f = await startAudioProcessingFixture(t);
  const input = {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 1024,
    durationSeconds: 30,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  const requestId = randomUUID();
  const first = await f.request('POST', '/jobs', { requestId, input });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.headers['cache-control'], 'no-store');
  const again = await f.request('POST', '/jobs', { requestId, input });
  assert.equal(again.body.id, first.body.id);
  const other = await f.request(
    'GET',
    `/jobs/${first.body.id}`,
    undefined,
    'other',
  );
  assert.equal(other.status, 404);
  const stored = await f.jobs.findById(first.body.id).lean();
  f.fakeStorage.put(stored.inputReservation);
  assert.equal(
    (await f.request('POST', `/jobs/${first.body.id}/upload-complete`, {}))
      .status,
    200,
  );
  assert.equal(
    (
      await f.request('POST', `/jobs/${first.body.id}/download-url`, {
        artifact: 'output',
      })
    ).status,
    409,
  );
  const grant = await f.request('POST', `/jobs/${first.body.id}/download-url`, {
    artifact: 'input',
  });
  assert.equal(grant.status, 200);
  assert.equal(grant.headers['cache-control'], 'no-store');
  assert.equal(
    (await f.request('POST', '/jobs', { requestId: randomUUID(), input }))
      .status,
    409,
  );
  // Historical terminal rows exercise pagination without bypassing current admission.
  const addHistory = () =>
    f.jobs.create({
      userId: stored.userId,
      requestId: randomUUID(),
      requestHash: 'a'.repeat(64),
      inputReservation: { ...stored.inputReservation },
      status: 'failed',
      finishedAt: new Date(),
    });
  for (let i = 0; i < 2; i++) await addHistory();
  const page = await f.request('GET', '/jobs?limit=2');
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 2);
  assert.ok(page.body.nextCursor);
  assert.doesNotMatch(
    JSON.stringify(page.body),
    /versionId|requestHash|sha256|users\/|attemptId|sessionId|https:/,
  );
  await addHistory();
  const tail = await f.request(
    'GET',
    `/jobs?limit=2&cursor=${page.body.nextCursor}`,
  );
  assert.equal(tail.body.items.length, 1);
  assert.equal(tail.body.items[0].id, first.body.id);
  assert.equal((await f.request('GET', '/jobs?cursor=bad')).status, 400);
  assert.equal((await f.request('GET', '/jobs?limit=101')).status, 400);
  assert.equal(
    (
      await f.request('POST', '/jobs', {
        requestId: randomUUID(),
        input,
        userId: 'injected',
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request('GET', '/jobs', undefined, 'worker')).status,
    401,
  );
  await f.restartApi();
  const persisted = await f.request('GET', `/jobs/${first.body.id}`);
  assert.equal(persisted.status, 200);
  assert.equal(persisted.body.status, 'queued');
});
