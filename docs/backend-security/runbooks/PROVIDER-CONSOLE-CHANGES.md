# Provider and VPS changes: operator checklist

**Status:** documentation only; every external item is currently unchecked.
**Rule:** code branches prepare and validate contracts but do not perform these
changes. The operator records date, account/project, sanitized evidence, and result
after the owning implementation branch is accepted.

Never paste credentials, bucket URLs, connection strings, account IDs, private
media, or screenshots containing personal data into Git.

## 1. Preflight

- [ ] Confirm the implementation branch owning the setting is merged and deployed
      to a non-production test environment first.
- [ ] Confirm the exact AWS account/region/bucket, Atlas project/cluster, Redis
      service, and environment without printing secrets.
- [ ] Export or record existing non-secret policy/configuration for rollback.
- [ ] Confirm the change will not delete current objects/data or interrupt another
      environment.
- [ ] Set a cost alert/contact before enabling new public traffic.

## 2. AWS S3 privacy and request controls

- [ ] Keep all four S3 Block Public Access settings enabled.
- [ ] Keep bucket/object ACL public access disabled.
- [ ] Confirm default encryption is enabled.
- [ ] Confirm bucket versioning is enabled because the backend pins immutable
      versions.
- [ ] Confirm the backend IAM principal has only required exact bucket/object
      actions and cannot administer unrelated AWS resources.
- [ ] Add/test a bucket-policy denial for presigned query requests whose
      `s3:signatureAge` exceeds `600000` milliseconds.
- [ ] Confirm the policy does not block valid ten-minute upload/download grants,
      worker attempt grants, or required signed checksum/content headers.
- [ ] Test with a synthetic exact object: valid fresh request succeeds; older
      signature is denied; wrong key/header/checksum is denied.
- [ ] Record only sanitized policy revision/evidence, never a presigned URL.

Do not paste a ready-to-run policy with a guessed bucket ARN. Generate/review the
policy against the actual account and existing statements so a broad `Deny` does
not break AWS service access.

## 3. S3 storage lifecycle

- [ ] Confirm successful audio is written with `INTELLIGENT_TIERING` or transitions
      through a narrowly scoped `users/` lifecycle rule accepted by branch B.
- [ ] Confirm Frequent → Infrequent after 30 inactive days.
- [ ] Confirm Archive Instant Access after 90 inactive days.
- [ ] Keep optional Archive Access and Deep Archive Access disabled for launch.
- [ ] Do not add expiration for successful outputs; they persist until job/account
      deletion.
- [ ] Configure incomplete multipart cleanup only if the finalized upload protocol
      uses multipart and the rule cannot affect complete objects.
- [ ] Do not create a broad input-prefix expiration rule until branch B supplies a
      tested tag/prefix contract. Application cleanup remains authoritative.
- [ ] Observe a synthetic/test-tagged object and record lifecycle configuration;
      do not claim a 30/90-day transition was observed immediately.

## 4. AWS cost protection

- [ ] Configure AWS Budgets or equivalent billing alert below the tolerated monthly
      spend.
- [ ] Configure a second urgent threshold and a responsible notification contact.
- [ ] Enable a cost anomaly alert for S3 request, storage, and data-transfer spikes
      when available.
- [ ] Review current AWS-wide internet-transfer usage because the free allowance is
      aggregated across services/regions.
- [ ] Compare provider billing data with the backend's 80 GB estimated service
      ceiling; record that estimates are not invoice-perfect actual bytes.
- [ ] Define the manual response when alerts fire: inspect, restrict grants, lower
      global policy, or disable new processing without deleting existing data.

## 5. MongoDB Atlas Free

The Branch 4 application health sampler now reports the sanitized
`MONGODB_STORAGE_PRESSURE` code when data plus index size reaches its early local
warning threshold. This is an application signal only; it does not configure an
Atlas alert or prove current provider usage.

- [ ] Confirm this environment is using the intended Free cluster and current
      provider limits.
- [ ] Restrict network access to required application/operator sources; do not use
      an unrestricted production allowlist.
- [ ] Use a least-privilege application database user and separate environments.
- [ ] Confirm TLS and authenticated connection configuration without logging the URI.
- [ ] Add available alerts for logical size, connections, network, and operation
      rate at early and urgent thresholds.
- [ ] Review data plus index size; the Free 0.5 GB limit includes both.
- [ ] Verify TTL indexes and bounded cleanup with synthetic data after branches A-D.
- [ ] Confirm no branch assumes disk-spilling aggregation, private endpoints, or
      Free-tier features that Atlas does not provide.

Backups/disaster recovery are intentionally outside this roadmap.

## 6. Redis on the shared 4 GB VPS

The Branch 4 application health sampler now reports sanitized
`REDIS_MEMORY_UNBOUNDED`, `REDIS_EVICTION_POLICY_UNSAFE`, or
`REDIS_MEMORY_PRESSURE` codes. These are application signals only; they do not
change `maxmemory`, eviction policy, authentication, firewall, or monitoring.

- [ ] Confirm Redis is private or firewall-restricted and authenticated.
- [ ] Confirm the application uses the intended Redis database/environment.
- [ ] Set an initial `maxmemory 256mb` after reviewing current usage.
- [ ] Set `maxmemory-policy noeviction` so security counters are not silently lost.
- [ ] Persist the settings in Redis configuration, not only a temporary runtime
      command.
- [ ] Leave RAM for Redis overhead, fork/persistence behavior, NestJS, and the OS.
- [ ] Monitor `used_memory`, RSS, fragmentation, rejected writes, connections,
      expired keys, and application 503s.
- [ ] Test in a safe environment that memory pressure returns controlled errors and
      does not make costly endpoints unlimited.
- [ ] Define rollback to the previous values and restart procedure; do not restart
      the live VPS without explicit authorization and a maintenance decision.

## 7. Firebase and CapRover/deployment follow-up

- [ ] Confirm new admin routes use existing Firebase/admin permissions and deployed
      environment keys only.
- [ ] Confirm deletion cleanup identity permissions in a test project before real
      account deletion.
- [ ] Update safe environment-key examples without storing values in Git.
- [ ] Deploy backend/dashboard only after their branch tests and owner approval.
- [ ] Verify HTTPS/CORS/security headers and health after deployment.
- [ ] Run synthetic account quota/media/queue/restriction/deletion smoke tests.
- [ ] Keep real user data and real account deletion out of smoke tests.

## 8. Evidence record

For each completed item record outside secret material:

- provider/environment name;
- UTC date/time and operator;
- owning code commit/release;
- old/new non-secret setting;
- validation performed and outcome;
- rollback status;
- remaining risk.
