# SEN-10 — Sampled cross-component tracing

Status: TODO, follow-up scope. Priority: P2. Dependency: SEN-09 error-monitoring gate.

## Work

1. Establish a budget from phase-one usage. Proposed initial canary trace sample
   rate is 5%, with health checks, polling, worker heartbeats and SDK traffic
   excluded. Validate parent-sampling behavior and provider quotas; do not blindly
   honor a public client's request for 100% sampling.
2. Enable backend route-template and short dependency spans only after checking
   their data attributes for credentials, statements, identifiers and raw URLs.
   Turn on browser/mobile request spans only for the exact configured MusicMute
   API origin and reviewed route boundaries.
3. Add `sentry-trace` and `baggage` to the backend's explicit CORS allowlist when
   browser propagation is enabled. Add W3C headers only if the chosen integration
   requires them. Validate length/format and ignore malformed or untrusted context.
4. Exclude S3 uploads/downloads, signed grants, Firebase, YouTube, owner-hosted
   model downloads and arbitrary URLs from propagation. Test URLs/redirects and
   each transfer transport rather than relying on a permissive regex.
5. Verify Router 8 and native networking compatibility with pinned SDKs. Use
   small explicit spans if automatic integration is unsupported; no framework
   upgrade belongs to this task without a separate requirement.
6. Design asynchronous trace continuation or span links across job enqueue/claim
   and Node/Python requests. Review required persistence/protocol changes first,
   bound context data, maintain backward compatibility and regenerate the worker
   protocol from its canonical backend definition. Source IDs alone are not
   trace context, and polling requests are not the original job's parent span.
7. Instrument short preparation, transfer, separation and encode stages, avoiding
   per-window/span floods and multi-hour open transactions. Preserve existing
   performance reports and direct-owner model source policy.
8. Keep profiling/replay/log pipelines as separately scoped work. Trace hooks
   vary across SDK versions (including streaming/static spans); test the actual
   serialized span format rather than assuming an error `beforeSend` covers it.

## Acceptance

- [ ] A synthetic client/API/job/worker flow shows the intended trace relationship.
- [ ] CORS preflight and sampled/unsampled requests preserve API behavior.
- [ ] No trace header reaches a disallowed host and no sensitive payload enters spans.
- [ ] Sampling and maximum span volume meet the agreed budget under retries/concurrency.
- [ ] Enabled/offline tracing preserves job timings, authority and mobile responsiveness.
- [ ] Per-component disabling leaves existing error capture operational.
