# MusicMute local logs MCP

Read-only stdio MCP over the same private JSONL capture used by Logdy. See the
[shared logging guide](../../docs/local-logging/README.md) for setup, privacy,
registration, reconnection, archive policy and actual source coverage.

```sh
npm ci --ignore-scripts
npm test
npm run build
node scripts/verify-live.mjs
```

The five tools are `search_logs`, `trace_request`, `trace_events`, `error_summary`
and `list_log_archives`. Default result limit is 50, maximum 200 (summary groups
maximum 100). Scans read at most 32 MiB per page; result budget is 256 KiB and
record budget 1 MiB. Two queries may run concurrently. Signed cursors bind filters,
operation and an immutable file snapshot; archive queries have independent cursors.

Payloads require `includePayloads: true`. Exact filters include source, instance,
capture, request/trace/user, operation/operationId/result/service/job/import/worker identity,
category/name/phase/method/route/severity/status and time range. Query text is a
literal substring, never evaluated as a regex or instruction. No tool accepts a
path, command or configuration mutation. MCP output includes coverage and warnings;
absence in a partial scan is not proof that something did not happen.
