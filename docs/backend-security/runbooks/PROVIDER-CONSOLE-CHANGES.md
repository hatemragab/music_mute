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
- [ ] Confirm the exact R2 account/bucket, Atlas project/cluster, Redis
      service, and environment without printing secrets.
- [ ] Export or record existing non-secret policy/configuration for rollback.
- [ ] Confirm the change will not delete current objects/data or interrupt another
      environment.
- [ ] Set a cost alert/contact before enabling new public traffic.

## 2. Private Cloudflare R2 and request controls

See [current R2 setup](../../r2-storage/README.md). Storage setup remains manual;
these checkboxes are not evidence of an executed cloud change.

- [ ] Create/use private `music-mute` with Standard storage.
- [ ] Keep `r2.dev` and public custom domains disabled.
- [ ] Restrict R2 S3 API credentials to the required bucket and object read/write;
      provide them only to the backend through its runtime secret configuration.
- [ ] Set required `STORAGE_PROVIDER=r2`, account-root `STORAGE_ENDPOINT` (without
      bucket/path/trailing slash), `STORAGE_REGION=auto`, `STORAGE_BUCKET`,
      `STORAGE_ACCESS_KEY_ID`, and `STORAGE_SECRET_ACCESS_KEY`.
- [ ] Remove obsolete AWS provider variables rather than enabling a fallback.
- [ ] Configure exact browser origins/methods/signed headers in R2 CORS, and the
      exact R2 origin in browser CSP. Never use wildcard/public access to fix CORS.
- [ ] Test a bounded synthetic PUT with matching signed checksum and metadata;
      wrong checksum/header and overwrite must fail. HEAD must match ETag, type,
      size and signed checksum metadata; optional returned checksum must match.
- [ ] Test fresh/expired signed GET, Range, and browser upload/download.
- [ ] Publish and verify required runtime/qualification/APK artifacts; do not invent
      ETags or mirror model weights into R2.
- [ ] Record only redacted result evidence, never a signed URL or credential.

R2 does not implement the old AWS bucket versioning, ACL/acceleration or
`signatureAge` policy design. Keep bounded signed expiration and existing
application authorization rather than attempting to recreate unsupported controls.

## 3. R2 retention and cleanup

- [ ] Keep Standard; no Infrequent Access or automatic tier transition.
- [ ] Preserve completed originals/results until job/account deletion.
- [ ] Verify failed/invalid/abandoned/stale-attempt exact-key cleanup and recovery
      with synthetic data, including late/uncertain PUT completion: first free DELETE
      after recorded grant deadline plus one hour, durable firstDeletedAt, and
      second free DELETE two hours later before completion. Restart/replica races
      must preserve the stage; no HEAD/list polling. The window is application
      policy, not a provider-wide deadline for unlimited external transfers.
- [ ] Never expire a broad successful-media prefix or delete unrelated objects.
- [ ] Add incomplete multipart expiration only if a future supported flow actually
      uses multipart and the rule cannot affect complete objects.
- [ ] Let the owner perform the separately planned fresh MongoDB reset; this
      runbook does not authorize database/object deletion.

## 4. Cost protection

- [ ] Review R2 account-level Standard storage and Class A/Class B operations;
      configure available billing thresholds/contacts without adding a paid proxy.
- [ ] Keep ordinary tests local and real synthetic tests explicitly opt-in,
      minimal and scoped to a dedicated test bucket.
- [ ] Confirm health views report cached observations and do not poll storage.
- [ ] Compare actual provider billing with grant estimates; free egress does not
      make storage, GET/HEAD or writes universally free.
- [ ] Review old AWS resources separately: wiping MongoDB does not stop their
      charges. This implementation does not delete or administer those resources.
- [ ] Define the manual response to unexpected spend: inspect usage, restrict
      grants or disable new processing without deleting retained media.

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
