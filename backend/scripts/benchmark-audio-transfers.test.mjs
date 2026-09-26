import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { benchmark, parseOptions } from './benchmark-audio-transfers.mjs';
const options = {
  bucket: 'test-bucket',
  region: 'us-east-2',
  runs: 1,
  sizes: [1],
  compare: true,
};
const body = Buffer.alloc(1024 * 1024);
const checksum = createHash('sha256').update(body).digest('base64');
function fixture({
  enabled = true,
  failPut = false,
  failDelete = false,
  failHead = false,
  corruptGet = false,
} = {}) {
  const calls = [];
  const regional = {
    send: async (command) => {
      calls.push(command);
      switch (command.constructor.name) {
        case 'GetBucketVersioningCommand':
          return { Status: 'Enabled' };
        case 'GetBucketAccelerateConfigurationCommand':
          return { Status: enabled ? 'Enabled' : 'Suspended' };
        case 'HeadObjectCommand':
          if (failHead)
            throw Object.assign(new Error('secret'), {
              name: 'NotFound',
              $metadata: { httpStatusCode: 404 },
            });
          return {
            VersionId: 'recovered',
            ChecksumSHA256: checksum,
            ContentLength: body.length,
          };
        case 'DeleteObjectCommand':
          if (failDelete) throw new Error('secret');
          return {};
        default:
          throw new Error('Unexpected operation');
      }
    },
    destroy() {},
  };
  const accelerated = { destroy() {} };
  let transfers = 0;
  return {
    calls,
    get transfers() {
      return transfers;
    },
    dependencies: {
      regional,
      accelerated,
      sign: async (_client, command) => {
        calls.push(command);
        return 'https://fixture.invalid/?signed=secret';
      },
      fetch: async (_url, init) => {
        transfers++;
        if (init.method === 'PUT') {
          if (failPut) throw new Error('secret');
          return new Response(null, {
            status: 200,
            headers: { 'x-amz-version-id': 'new-version' },
          });
        }
        return new Response(corruptGet ? Buffer.alloc(body.length, 1) : body);
      },
    },
  };
}
test('requires explicit writes and bounded arguments', () => {
  const args = ['--bucket', 'test-bucket', '--region', 'us-east-2'];
  assert.throws(() => parseOptions(args));
  assert.equal(parseOptions([...args, '--allow-writes']).runs, 3);
  for (const extra of [
    ['--runs', '6'],
    ['--sizes-mib', '4,4'],
    ['--sizes-mib', '500'],
    ['--unknown'],
  ])
    assert.throws(() => parseOptions([...args, '--allow-writes', ...extra]));
});
test('refuses disabled acceleration before writes', async () => {
  const f = fixture({ enabled: false });
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, false);
  assert.equal(f.transfers, 0);
});
test('compares signed transfers and removes only generated immutable versions', async () => {
  const f = fixture();
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, true);
  assert.deepEqual(
    report.samples.map((s) => s.mode),
    ['regional', 'accelerated'],
  );
  const deletes = f.calls.filter(
    (c) => c.constructor.name === 'DeleteObjectCommand',
  );
  assert.equal(deletes.length, 2);
  for (const command of deletes) {
    assert.match(command.input.Key, /^transfer-benchmarks\/[a-f0-9-]{36}\//);
    assert.equal(command.input.VersionId, 'new-version');
  }
  assert.doesNotMatch(JSON.stringify(report), /signed|secret/);
});
test('recovers uncertain PUT by checksum and deletes exact version', async () => {
  const f = fixture({ failPut: true });
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, false);
  assert.equal(report.cleanup_pending.length, 0);
  assert.equal(
    f.calls.find((c) => c.constructor.name === 'DeleteObjectCommand').input
      .VersionId,
    'recovered',
  );
  assert.doesNotMatch(JSON.stringify(report), /secret/);
});
test('retains cleanup evidence for a PUT not yet visible', async () => {
  const f = fixture({ failPut: true, failHead: true });
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, false);
  assert.equal(report.cleanup_pending.length, 1);
  assert.equal(
    f.calls.some((c) => c.constructor.name === 'DeleteObjectCommand'),
    false,
  );
});
test('reports cleanup failure without leaking errors', async () => {
  const f = fixture({ failDelete: true });
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, false);
  assert.equal(report.cleanup_pending.length, 2);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
});
test('verifies downloads before reporting samples', async () => {
  const f = fixture({ corruptGet: true });
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, false);
  assert.equal(report.samples.length, 0);
  assert.equal(report.cleanup_pending.length, 0);
});
