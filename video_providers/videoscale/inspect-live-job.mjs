// Read-only verification inside API container. Each confirmed object costs one R2 HEAD.
// Usage: node inspect-live-job.mjs EXACT_TEST_JOB_ID --allow-storage-read
import mongoose from "file:///app/node_modules/mongoose/index.js";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
const { S3Client, HeadObjectCommand } =
  createRequire("/app/package.json")("@aws-sdk/client-s3");
const id = process.argv[2];
if (
  !/^[a-f0-9]{24}$/.test(id ?? "") ||
  process.argv[3] !== "--allow-storage-read" ||
  process.argv.length !== 4
)
  throw new Error(
    "Exact tested job ID and --allow-storage-read required; R2 HEAD charges may apply",
  );
if (
  process.env.STORAGE_PROVIDER !== "r2" ||
  process.env.STORAGE_REGION !== "auto" ||
  !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(
    process.env.STORAGE_ENDPOINT ?? "",
  ) ||
  !process.env.STORAGE_BUCKET ||
  !process.env.STORAGE_ACCESS_KEY_ID ||
  !process.env.STORAGE_SECRET_ACCESS_KEY
)
  throw new Error("Explicit backend-only R2 STORAGE_* configuration required");
let db;
const storage = new S3Client({
  region: "auto",
  endpoint: process.env.STORAGE_ENDPOINT,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  },
  maxAttempts: 1,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});
async function verifyObject(object) {
  if (!object) return null;
  if (!object.etag || !object.key || !object.sha256)
    throw new Error("Incomplete stored object identity");
  const head = await storage.send(
    new HeadObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: object.key,
      IfMatch: object.etag,
    }),
    { abortSignal: AbortSignal.timeout(15000) },
  );
  return {
    bytes_match: head.ContentLength === object.bytes,
    checksum_metadata_match: head.Metadata?.sha256 === object.sha256,
    returned_checksum_match: head.ChecksumSHA256
      ? head.ChecksumSHA256 === object.sha256
      : null,
    etag_match: head.ETag === object.etag,
    content_type_match: head.ContentType === object.contentType,
  };
}
try {
  db = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
  const job = await db.collection("audio_jobs").findOne(
    { _id: new mongoose.Types.ObjectId(id) },
    {
      projection: {
        status: 1,
        inputObject: 1,
        outputObject: 1,
        importStageTimings: 1,
        lastError: 1,
        sourceKind: 1,
      },
    },
  );
  if (!job) throw new Error("Test job not found");
  console.log(
    JSON.stringify({
      status: job.status,
      source_kind: job.sourceKind,
      input_confirmed: Boolean(job.inputObject),
      input_bytes: job.inputObject?.bytes ?? null,
      output_confirmed: Boolean(job.outputObject),
      output_bytes: job.outputObject?.bytes ?? null,
      input_storage: await verifyObject(job.inputObject),
      output_storage: await verifyObject(job.outputObject),
      error_code: job.lastError?.code ?? null,
      import_stage_timings: job.importStageTimings,
      scratch_entries: (await readdir(process.env.URL_IMPORT_TEMP_ROOT)).length,
    }),
  );
} catch {
  console.error(
    "Test-job storage verification failed; inspect redacted backend diagnostics.",
  );
  process.exitCode = 1;
} finally {
  storage.destroy();
  await db?.close();
}
