// Synthetic loopback transfer proof. No SaaS, database, S3 or user media access.
// node verify-transfer.mjs /absolute/backend/root
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { ImportFiles } = await import(pathToFileURL(join(resolve(process.argv[2]), 'dist/url-imports/import-files.js')));
const root = await mkdtemp(join(tmpdir(), 'musicmute-synthetic-transfer-'));
const files = new ImportFiles(join(root, 'imports'), 0);
const payload = Buffer.alloc(3_597_607, 0x61);
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  req.resume();
  res.writeHead(200, { 'Content-Length': payload.length, Connection: 'close' });
  res.end(req.url === '/short' ? payload.subarray(0, 1024) : payload);
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = { method: 'POST', headers: {}, body: '{}' };
  for (let i = 0; i < 12; i++) {
    const result = await files.withFile((path, signal) => files.download(origin, path, 5_000_000, signal, request));
    assert.equal(result.bytes, payload.length);
    assert.equal(result.sha256, createHash('sha256').update(payload).digest('base64'));
  }
  await assert.rejects(files.withFile((path, signal) => files.download(`${origin}/short`, path, 5_000_000, signal, request)));
  assert.equal(requests, 13);
  assert.equal((await readdir(files.root)).length, 0);
  console.log(JSON.stringify({ event: 'synthetic-transfer-passed', successful_transfers: 12, truncated_rejected: true, requests, remaining_files: 0, node: process.version }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
