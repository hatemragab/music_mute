# Official references and design implications

These sources support the cost/security constraints in this package. Recheck them
before production rollout because provider pricing and limits can change.

## AWS

- [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/) — storage, requests, and
  internet data transfer can create cost; inbound transfer is generally free and
  the internet-transfer allowance is aggregated across AWS services/regions.
- [S3 Intelligent-Tiering](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intelligent-tiering-overview.html)
  — automatic Infrequent Access after 30 inactive days and Archive Instant Access
  after 90; optional archive tiers require asynchronous restore and are excluded.
- [AWS presigned URL best practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices.html)
  — presigned URLs are bearer capabilities and should be constrained by scope,
  expiry, logging, and data-perimeter controls.
- [AWS presigned URL FAQ](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/faq.html)
  — a presigned request can be reused and is not inherently single-use. This is why
  MusicMute counts grants and estimated bytes rather than claiming actual GET count.
- [S3 policy keys for signature age](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html)
  — bucket policy can deny overly old SigV4 query signatures through
  `s3:signatureAge`.

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
  size, content type, checksum, and immutable version.
- `backend/src/rate-limits/` already supplies shared Redis, hashed keys, and atomic
  rate budgets.
- `backend/src/worker-fleet/` already supplies claim, attempt, lease, and stale-owner
  fences.
- `backend/src/users/account-deletion-*` already supplies retryable cleanup and
  identity fences and an exact fifteen-day recovery policy.

Local source evidence establishes implemented code, not live provider configuration.
