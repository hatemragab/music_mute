import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { benchmark, parseOptions } from './benchmark-audio-transfers.mjs';
const environment = {
  STORAGE_PROVIDER: 'r2',
  STORAGE_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
  STORAGE_REGION: 'auto',
  STORAGE_BUCKET: 'music-mute',
  STORAGE_ACCESS_KEY_ID: 'fixture-key',
  STORAGE_SECRET_ACCESS_KEY: 'fixture-secret',
};
const args = ['--bucket', 'test-bucket', '--allow-writes'];
const options = parseOptions(args, environment);
const body = Buffer.alloc(1024 * 1024);
const checksum = createHash('sha256').update(body).digest('base64');
const etag = '"opaque-etag"';
function fixture({
  failPut = false,
  failDelete = false,
  failHead = false,
  corruptGet = false,
  invalidHead = false,
  missingChecksum = false,
  missingEtag = false,
} = {}) {
  const calls = [];
  const client = {
    send: async (command) => {
      calls.push(command);
      switch (command.constructor.name) {
        case 'HeadObjectCommand':
          if (failHead)
            throw Object.assign(new Error('secret'), {
              name: 'NotFound',
              $metadata: { httpStatusCode: 404 },
            });
          return {
            ETag: etag,
            ChecksumSHA256: missingChecksum ? undefined : checksum,
            Metadata: { sha256: invalidHead ? 'wrong' : checksum },
            ContentLength: body.length,
            ContentType: 'application/octet-stream',
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
  let transfers = 0;
  return {
    calls,
    get transfers() {
      return transfers;
    },
    dependencies: {
      client,
      sign: async (_client, command, signing) => {
        calls.push(command);
        if (command.constructor.name === 'PutObjectCommand') {
          assert.equal(command.input.Metadata.sha256, checksum);
          assert.equal(command.input.ChecksumSHA256, checksum);
          assert.equal(command.input.IfNoneMatch, '*');
          assert.equal(command.input.StorageClass, undefined);
          assert.equal(
            signing.unhoistableHeaders.has('x-amz-meta-sha256'),
            true,
          );
        }
        return 'https://fixture.invalid/?signed=secret';
      },
      fetch: async (_url, init) => {
        transfers++;
        if (init.method === 'PUT') {
          assert.equal(init.headers['x-amz-meta-sha256'], checksum);
          assert.equal(init.headers['If-None-Match'], '*');
          if (failPut) throw new Error('secret');
          return new Response(null, {
            status: 200,
            headers: missingEtag ? {} : { etag },
          });
        }
        assert.equal(init.headers['If-Match'], etag);
        return new Response(corruptGet ? Buffer.alloc(body.length, 1) : body);
      },
    },
  };
}
test('requires explicit writes, dedicated bucket and bounded arguments', () => {
  assert.throws(() => parseOptions(['--bucket', 'test-bucket'], environment));
  assert.equal(options.runs, 1);
  assert.deepEqual(options.sizes, [1]);
  for (const extra of [
    ['--runs', '4'],
    ['--sizes-mib', '4,4'],
    ['--sizes-mib', '500'],
    ['--unknown'],
    ['--compare-acceleration'],
    ['--bucket', 'duplicate'],
  ])
    assert.throws(() => parseOptions([...args, ...extra], environment));
  assert.throws(() =>
    parseOptions(['--bucket', 'music-mute', '--allow-writes'], environment),
  );
});
test('requires R2 root endpoint and explicit credentials, ignoring AWS configuration', () => {
  for (const changes of [
    { STORAGE_ENDPOINT: `${environment.STORAGE_ENDPOINT}/test-bucket` },
    { STORAGE_ENDPOINT: 'https://test-bucket.s3.amazonaws.com' },
    { STORAGE_ENDPOINT: `${environment.STORAGE_ENDPOINT}:443` },
    { STORAGE_PROVIDER: 's3' },
    { STORAGE_REGION: 'eu-west-1' },
    { STORAGE_ACCESS_KEY_ID: undefined, AWS_ACCESS_KEY_ID: 'fixture-key' },
    { STORAGE_SECRET_ACCESS_KEY: '' },
  ])
    assert.throws(() => parseOptions(args, { ...environment, ...changes }));
});
test('confirms and downloads a unique R2 object without version IDs or bucket operations', async () => {
  const f = fixture({ missingChecksum: true });
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, true);
  assert.equal(report.samples.length, 1);
  const heads = f.calls.filter(
    (c) => c.constructor.name === 'HeadObjectCommand',
  );
  assert.equal(heads.length, 1);
  assert.equal(heads[0].input.IfMatch, etag);
  const get = f.calls.find((c) => c.constructor.name === 'GetObjectCommand');
  assert.equal(get.input.IfMatch, etag);
  const deletes = f.calls.filter(
    (c) => c.constructor.name === 'DeleteObjectCommand',
  );
  assert.equal(deletes.length, 1);
  assert.match(deletes[0].input.Key, /^transfer-benchmarks\/[a-f0-9-]{36}\//);
  assert.equal(deletes[0].input.VersionId, undefined);
  assert.doesNotMatch(JSON.stringify(report), /signed|secret|fixture-key/);
});
test('recovers uncertain PUT by exact checksum metadata and size before cleanup', async () => {
  const f = fixture({ failPut: true });
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, false);
  assert.equal(report.cleanup_pending.length, 0);
  assert.equal(
    f.calls.some((c) => c.constructor.name === 'DeleteObjectCommand'),
    true,
  );
  assert.doesNotMatch(JSON.stringify(report), /secret/);
});
test('retains exact cleanup evidence for a PUT not yet visible or not matching', async () => {
  for (const failure of [{ failHead: true }, { invalidHead: true }]) {
    const f = fixture({ failPut: true, ...failure });
    const report = await benchmark(options, f.dependencies);
    assert.equal(report.success, false);
    assert.equal(report.cleanup_pending.length, 1);
    assert.equal(
      f.calls.some((c) => c.constructor.name === 'DeleteObjectCommand'),
      false,
    );
  }
});
test('rejects malformed upload identity', async () => {
  const f = fixture({ missingEtag: true });
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, false);
  assert.equal(report.samples.length, 0);
});
test('reports cleanup failure without leaking errors', async () => {
  const f = fixture({ failDelete: true });
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, false);
  assert.equal(report.cleanup_pending.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
});
test('verifies downloads before reporting samples', async () => {
  const f = fixture({ corruptGet: true });
  const report = await benchmark(options, f.dependencies);
  assert.equal(report.success, false);
  assert.equal(report.samples.length, 0);
  assert.equal(report.cleanup_pending.length, 0);
});
