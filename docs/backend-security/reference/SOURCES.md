# Official references and design implications

These sources support the cost/security constraints in this package. Recheck them
before production rollout because provider pricing and limits can change.

## Cloudflare R2

- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
  defines supported operations; AWS versioning, bucket ACL/acceleration and tiering
  assumptions are not part of MusicMute's R2 setup.
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/): Standard storage and
  request counts remain billable beyond account allowances; direct egress and
  DeleteObject are free. Do not claim every read/write is free.
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
  are temporary bearer capabilities generated locally with the retained AWS SDK;
  backend authorization and exact signed headers remain mandatory.
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/) is separate from
  API CORS and browser CSP; keep explicit origins, methods and signed headers.
- [Current MusicMute storage guide](../../r2-storage/README.md) records the approved
  fresh-database ETag identity, cleanup, setup and bounded verification contract.

## MongoDB Atlas

- [Atlas Free cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)
  — Free storage is 0.5 GB including documents and indexes, with bounded operations,
  connections, and rolling data transfer. This drives compact summaries, TTL, and
  narrow indexes.
- [Atlas storage FAQ](https://www.mongodb.com/docs/atlas/reference/faq/storage/)
  — Free/Flex maximum storage is a hard limit, so the application must monitor and
  clean bounded operational records before reaching it.

## Redis

- [Redis key eviction and `maxmemory`](https://redis.io/docs/latest/develop/reference/eviction/)
  — `maxmemory` bounds dataset memory and `noeviction` rejects new writes rather
  than silently removing security keys.
- [Redis memory optimization](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
  — an unbounded instance may consume free host memory and RSS can remain near peak,
  supporting a conservative ceiling on the shared VPS.
- [Redis administration](https://redis.io/docs/latest/operate/oss_and_stack/management/admin/)
  — leave overhead/headroom instead of setting `maxmemory` equal to all free RAM.

## API security

- [OWASP API4:2023 Unrestricted Resource Consumption](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/)
  — enforce upload size, operation frequency, execution/resource limits, and
  third-party spending safeguards. This supports layered account/IP/service limits.
- [OWASP API6:2023 Unrestricted Access to Sensitive Business Flows](https://api-security.owasp.org/editions/2023/en/0xa6-unrestricted-access-to-sensitive-business-flows/)
  — protect cost-bearing business actions from automation without relying on one
  generic HTTP limit.

## Project-local evidence

- `backend/src/storage/storage-transfers.service.ts` already verifies exact key,
  size, content type, signed checksum metadata, and ETag.
- `backend/src/rate-limits/` already supplies shared Redis, hashed keys, and atomic
  rate budgets.
- `backend/src/worker-fleet/` already supplies claim, attempt, lease, and stale-owner
  fences.
- `backend/src/users/account-deletion-*` already supplies retryable cleanup and
  identity fences and an exact fifteen-day recovery policy.

Local source evidence establishes implemented code, not live provider configuration.
