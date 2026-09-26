import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  DeleteObjectCommand,
  GetBucketAccelerateConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const digest = (body) => createHash('sha256').update(body).digest('base64');
const request = () => ({ abortSignal: AbortSignal.timeout(30_000) });

export function parseOptions(args) {
  const allowed = new Set([
    '--bucket',
    '--region',
    '--runs',
    '--sizes-mib',
    '--allow-writes',
    '--compare-acceleration',
  ]);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key) || key in flags)
      throw new Error('Invalid or duplicate option');
    flags[key] = ['--allow-writes', '--compare-acceleration'].includes(key)
      ? true
      : args[++i];
  }
  const bucket = flags['--bucket'];
  const region = flags['--region'];
  const runs = Number(flags['--runs'] ?? 3);
  const sizes = String(flags['--sizes-mib'] ?? '4,16')
    .split(',')
    .map(Number);
  if (
    flags['--allow-writes'] !== true ||
    typeof bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    typeof region !== 'string' ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 5 ||
    sizes.length < 1 ||
    sizes.length > 2 ||
    new Set(sizes).size !== sizes.length ||
    sizes.some((size) => ![1, 4, 16].includes(size))
  )
    throw new Error(
      'Require --bucket, --region, --allow-writes; runs 1-5; sizes-mib at most two of 1,4,16',
    );
  return {
    bucket,
    region,
    runs,
    sizes,
    compare: flags['--compare-acceleration'] === true,
  };
}

async function cleanupSyntheticVersion(
  regional,
  object,
  versionId,
  checksum,
  bytes,
) {
  try {
    if (!versionId || versionId === 'null') {
      // Recover a lost PUT response only after proving this generated object's identity.
      // A 404 after timeout is inconclusive: retain the key for later reconciliation.
      const head = await regional.send(
        new HeadObjectCommand({ ...object, ChecksumMode: 'ENABLED' }),
        request(),
      );
      if (
        head.ChecksumSHA256 !== checksum ||
        head.ContentLength !== bytes ||
        !head.VersionId ||
        head.VersionId === 'null'
      )
        return { key: object.Key, version_id: null };
      versionId = head.VersionId;
    }
    await regional.send(
      new DeleteObjectCommand({ ...object, VersionId: versionId }),
      request(),
    );
    return null;
  } catch {
    return { key: object.Key, version_id: versionId ?? null };
  }
}

/** Synthetic, bounded traffic only. No bucket setting changes or user media access. */
export async function benchmark(options, dependencies = {}) {
  const regional =
    dependencies.regional ??
    new S3Client({ region: options.region, maxAttempts: 1 });
  const accelerated =
    dependencies.accelerated ??
    new S3Client({
      region: options.region,
      maxAttempts: 1,
      useAccelerateEndpoint: true,
    });
  const transfer = dependencies.fetch ?? fetch;
  const sign = dependencies.sign ?? getSignedUrl;
  const report = { schema_version: 1, samples: [], cleanup_pending: [] };
  try {
    const versioning = await regional.send(
      new GetBucketVersioningCommand({ Bucket: options.bucket }),
      request(),
    );
    if (versioning.Status !== 'Enabled') throw new Error('Versioning required');
    if (options.compare) {
      const acceleration = await regional.send(
        new GetBucketAccelerateConfigurationCommand({ Bucket: options.bucket }),
        request(),
      );
      if (acceleration.Status !== 'Enabled')
        throw new Error(
          'Acceleration must already be enabled; this tool never enables it',
        );
    }
    const runId = randomUUID();
    for (const size of options.sizes) {
      const body = Buffer.alloc(size * 1024 * 1024);
      const checksum = digest(body);
      for (let round = 0; round < options.runs; round++) {
        const modes = options.compare
          ? round % 2
            ? ['accelerated', 'regional']
            : ['regional', 'accelerated']
          : ['regional'];
        for (const mode of modes) {
          const key = `transfer-benchmarks/${runId}/${size}-${round}-${mode}`;
          const object = { Bucket: options.bucket, Key: key };
          const client = mode === 'regional' ? regional : accelerated;
          let versionId;
          let putStarted = false;
          try {
            const url = await sign(
              client,
              new PutObjectCommand({
                ...object,
                ContentLength: body.length,
                ContentType: 'application/octet-stream',
                ChecksumSHA256: checksum,
                IfNoneMatch: '*',
              }),
              {
                expiresIn: 300,
                signableHeaders: new Set([
                  'content-type',
                  'if-none-match',
                  'x-amz-checksum-sha256',
                ]),
                unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
              },
            );
            const start = performance.now();
            putStarted = true;
            const response = await transfer(url, {
              method: 'PUT',
              redirect: 'error',
              signal: AbortSignal.timeout(120_000),
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(body.length),
                'x-amz-checksum-sha256': checksum,
                'If-None-Match': '*',
              },
              body,
            });
            await response.body?.cancel();
            const uploadMs = performance.now() - start;
            if (!response.ok) throw new Error('PUT failed');
            versionId = response.headers.get('x-amz-version-id');
            if (!versionId || versionId === 'null')
              throw new Error('Missing immutable version');
            const getUrl = await sign(
              client,
              new GetObjectCommand({ ...object, VersionId: versionId }),
              { expiresIn: 300 },
            );
            const downloadStart = performance.now();
            const download = await transfer(getUrl, {
              redirect: 'error',
              signal: AbortSignal.timeout(120_000),
            });
            if (!download.ok) {
              await download.body?.cancel();
              throw new Error('GET failed');
            }
            // The request is pinned to the synthetic object, with a maximum of 16 MiB.
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
              mode,
              bytes: body.length,
              round: round + 1,
              upload_ms: Math.round(uploadMs),
              download_ms: Math.round(downloadMs),
            });
          } finally {
            if (putStarted) {
              const pending = await cleanupSyntheticVersion(
                regional,
                object,
                versionId,
                checksum,
                body.length,
              );
              if (pending) report.cleanup_pending.push(pending);
            }
          }
        }
      }
    }
    return { ...report, success: report.cleanup_pending.length === 0 };
  } catch {
    // Provider errors can contain signed URLs, account details and credentials.
    return {
      ...report,
      success: false,
      error:
        'Benchmark failed; check credentials, versioning, acceleration and scoped permissions. No bucket settings changed.',
    };
  } finally {
    regional.destroy();
    accelerated.destroy();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes('--help')) {
    console.log(
      'node scripts/benchmark-audio-transfers.mjs --bucket NAME --region REGION --allow-writes [--runs 1-5] [--sizes-mib 4,16] [--compare-acceleration]\nCreates and deletes only unique synthetic transfer-benchmarks/ versions. Normal S3 transfer/request charges apply. Uses the AWS standard credential chain; never loads dotenv files.',
    );
  } else {
    try {
      const report = await benchmark(parseOptions(process.argv.slice(2)));
      console.log(JSON.stringify(report, null, 2));
      if (!report.success) process.exitCode = 1;
    } catch {
      console.error('Invalid benchmark options. Run with --help.');
      process.exitCode = 1;
    }
  }
}
