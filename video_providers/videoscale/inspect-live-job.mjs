// Read-only verification inside API container; pass only the explicitly tested job ID.
import mongoose from "file:///app/node_modules/mongoose/index.js";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
const { S3Client, HeadObjectCommand } =
  createRequire("/app/package.json")("@aws-sdk/client-s3");
const id = process.argv[2];
if (!/^[a-f0-9]{24}$/.test(id ?? ""))
  throw new Error("Exact tested job ID required");
const db = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
const s3 = new S3Client({ region: process.env.AWS_REGION, maxAttempts: 1 });
async function verifyObject(object) {
  if (!object) return null;
  const head = await s3.send(
    new HeadObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: object.key,
      VersionId: object.versionId,
      ChecksumMode: "ENABLED",
    }),
    { abortSignal: AbortSignal.timeout(15000) },
  );
  return {
    bytes_match: head.ContentLength === object.bytes,
    checksum_match: head.ChecksumSHA256 === object.sha256,
    version_match: head.VersionId === object.versionId,
    content_type_match: head.ContentType === object.contentType,
  };
}
try {
  const job = await db.collection("audio_jobs").findOne(
    { _id: new mongoose.Types.ObjectId(id) },
    {
      projection: {
        status: 1,
        extra_data: 1,
        inputObject: 1,
        outputObject: 1,
        importStageTimings: 1,
        lastError: 1,
        workerProgress: 1,
        sourceKind: 1,
      },
    },
  );
  if (!job) throw new Error("Test job not found");
  console.log(
    JSON.stringify({
      status: job.status,
      source_kind: job.sourceKind,
      extra_data: job.extra_data ?? null,
      input_confirmed: Boolean(job.inputObject),
      input_bytes: job.inputObject?.bytes ?? null,
      output_confirmed: Boolean(job.outputObject),
      output_bytes: job.outputObject?.bytes ?? null,
      input_s3: await verifyObject(job.inputObject),
      output_s3: await verifyObject(job.outputObject),
      error_code: job.lastError?.code ?? null,
      import_stage_timings: job.importStageTimings,
      scratch_entries: (await readdir(process.env.URL_IMPORT_TEMP_ROOT)).length,
    }),
  );
} finally {
  s3.destroy();
  await db.close();
}
