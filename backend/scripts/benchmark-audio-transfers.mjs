import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const contentType = 'application/octet-stream';
const digest = (body) => createHash('sha256').update(body).digest('base64');
const request = () => ({ abortSignal: AbortSignal.timeout(30_000) });
const validEtag = (value) =>
  typeof value === 'string' && /^"[\x21\x23-\x7e]{1,1022}"$/.test(value);

export function parseOptions(args, environment = process.env) {
  const allowed = new Set([
    '--bucket',
    '--endpoint',
    '--runs',
    '--sizes-mib',
    '--allow-writes',
  ]);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key) || key in flags)
      throw new Error('Invalid or duplicate option');
    flags[key] = key === '--allow-writes' ? true : args[++i];
  }
  const bucket = flags['--bucket'];
  const endpoint = flags['--endpoint'] ?? environment.STORAGE_ENDPOINT;
  const runs = Number(flags['--runs'] ?? 1);
  const sizes = String(flags['--sizes-mib'] ?? '1')
    .split(',')
    .map(Number);
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid R2 account endpoint');
  }
  if (
    flags['--allow-writes'] !== true ||
    typeof bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket === 'music-mute' ||
    bucket === environment.STORAGE_BUCKET ||
    !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint) ||
    url.protocol !== 'https:' ||
    !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    environment.STORAGE_PROVIDER !== 'r2' ||
    environment.STORAGE_REGION !== 'auto' ||
    !environment.STORAGE_ACCESS_KEY_ID?.trim() ||
    !environment.STORAGE_SECRET_ACCESS_KEY?.trim() ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 3 ||
    sizes.length < 1 ||
    sizes.length > 2 ||
    new Set(sizes).size !== sizes.length ||
    sizes.some((size) => ![1, 4, 16].includes(size))
  )
    throw new Error(
      'Require explicit --allow-writes, a dedicated --bucket, R2 STORAGE_* credentials and account endpoint; runs 1-3; at most two sizes from 1,4,16 MiB',
    );
  return {
    bucket,
    endpoint: url.origin,
    runs,
    sizes,
    credentials: {
      accessKeyId: environment.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: environment.STORAGE_SECRET_ACCESS_KEY,
    },
  };
}

function matches(head, checksum, bytes, etag) {
  return (
    validEtag(head.ETag) &&
    (!etag || head.ETag === etag) &&
    head.ContentLength === bytes &&
    head.ContentType === contentType &&
    head.Metadata?.sha256 === checksum &&
    (!head.ChecksumSHA256 || head.ChecksumSHA256 === checksum)
  );
}

async function cleanup(client, object, verified, checksum, bytes) {
  try {
    if (!verified) {
      const head = await client.send(
        new HeadObjectCommand({ ...object }),
        request(),
      );
      if (!matches(head, checksum, bytes))
        return { key: object.Key, reason: 'identity_unconfirmed' };
    }
    await client.send(new DeleteObjectCommand(object), request());
    return null;
  } catch {
    // A lost PUT response and subsequent 404 do not prove the upload cannot finish.
    // Retain exact-key evidence; reconcile after the signed grant/transfer window.
    return { key: object.Key, reason: 'reconcile_after_grant_expiry' };
  }
}

/** Explicit opt-in, bounded synthetic traffic; never reads user media or bucket lists. */
export async function benchmark(options, dependencies = {}) {
  const client =
    dependencies.client ??
    new S3Client({
      region: 'auto',
      endpoint: options.endpoint,
      credentials: options.credentials,
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  const transfer = dependencies.fetch ?? fetch;
  const sign = dependencies.sign ?? getSignedUrl;
  const report = {
    schema_version: 2,
    provider: 'r2',
    samples: [],
    cleanup_pending: [],
  };
  try {
    const runId = randomUUID();
    for (const size of options.sizes) {
      const body = Buffer.alloc(size * 1024 * 1024);
      const checksum = digest(body);
      for (let round = 0; round < options.runs; round++) {
        const object = {
          Bucket: options.bucket,
          Key: `transfer-benchmarks/${runId}/${size}-${round}`,
        };
        let putStarted = false;
        let verified = false;
        try {
          const url = await sign(
            client,
            new PutObjectCommand({
              ...object,
              ContentLength: body.length,
              ContentType: contentType,
              ChecksumSHA256: checksum,
              Metadata: { sha256: checksum },
              IfNoneMatch: '*',
            }),
            {
              expiresIn: 300,
              signableHeaders: new Set([
                'content-type',
                'if-none-match',
                'x-amz-checksum-sha256',
                'x-amz-meta-sha256',
              ]),
              unhoistableHeaders: new Set([
                'x-amz-checksum-sha256',
                'x-amz-meta-sha256',
              ]),
            },
          );
          const start = performance.now();
          putStarted = true;
          const response = await transfer(url, {
            method: 'PUT',
            redirect: 'error',
            signal: AbortSignal.timeout(120_000),
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(body.length),
              'x-amz-checksum-sha256': checksum,
              'x-amz-meta-sha256': checksum,
              'If-None-Match': '*',
            },
            body,
          });
          await response.body?.cancel();
          const uploadMs = performance.now() - start;
          if (!response.ok) throw new Error('PUT failed');
          const putEtag = response.headers.get('etag');
          if (!validEtag(putEtag)) throw new Error('Missing ETag');
          const head = await client.send(
            new HeadObjectCommand({ ...object, IfMatch: putEtag }),
            request(),
          );
          if (!matches(head, checksum, body.length, putEtag))
            throw new Error('HEAD identity failed');
          verified = true;
          const getUrl = await sign(
            client,
            new GetObjectCommand({ ...object, IfMatch: putEtag }),
            { expiresIn: 300 },
          );
          const downloadStart = performance.now();
          const download = await transfer(getUrl, {
            redirect: 'error',
            signal: AbortSignal.timeout(120_000),
            headers: { 'If-Match': putEtag },
          });
          if (!download.ok) {
            await download.body?.cancel();
            throw new Error('GET failed');
          }
          const chunks = [];
          let received = 0;
          for await (const chunk of download.body ?? []) {
            received += chunk.length;
            if (received > body.length)
              throw new Error('GET exceeded expected size');
            chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks);
          const downloadMs = performance.now() - downloadStart;
          if (bytes.length !== body.length || digest(bytes) !== checksum)
            throw new Error('GET integrity failed');
          report.samples.push({
            bytes: body.length,
            round: round + 1,
            upload_ms: Math.round(uploadMs),
            download_ms: Math.round(downloadMs),
          });
        } finally {
          if (putStarted) {
            const pending = await cleanup(
              client,
              object,
              verified,
              checksum,
              body.length,
            );
            if (pending) report.cleanup_pending.push(pending);
          }
        }
      }
    }
    return { ...report, success: report.cleanup_pending.length === 0 };
  } catch {
    // Underlying errors may contain signed URLs, account details or credentials.
    return {
      ...report,
      success: false,
      error:
        'R2 benchmark failed; verify dedicated test-bucket credentials, signed headers and permissions. No bucket settings changed.',
    };
  } finally {
    client.destroy();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes('--help')) {
    console.log(
      'node scripts/benchmark-audio-transfers.mjs --bucket DEDICATED_TEST_BUCKET --allow-writes [--endpoint R2_ACCOUNT_ENDPOINT] [--runs 1-3] [--sizes-mib 1,4]\nRequires STORAGE_PROVIDER=r2, STORAGE_REGION=auto, STORAGE_ENDPOINT and explicit STORAGE_ACCESS_KEY_ID/STORAGE_SECRET_ACCESS_KEY. Never loads dotenv or uses a default credential chain. Creates only unique synthetic transfer-benchmarks/ keys. Default: one 1 MiB PUT, HEAD, GET and DELETE. R2 request/storage charges may apply; no live test is run without --allow-writes.',
    );
  } else {
    try {
      const report = await benchmark(parseOptions(process.argv.slice(2)));
      console.log(JSON.stringify(report, null, 2));
      if (!report.success) process.exitCode = 1;
    } catch {
      console.error(
        'Invalid benchmark options or configuration. Run with --help.',
      );
      process.exitCode = 1;
    }
  }
}
