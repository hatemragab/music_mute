# MusicMute API client contract

This is the HTTP contract in this repository for the Android and iOS apps, the
administrator dashboard, and the worker runtime. [OpenAPI](../../backend/openapi.yaml)
defines the request and response schemas for each operation; the
[route matrix](../backend-security/route-matrix.md) records authentication,
ownership, limits, and the worker WebSocket boundary. Check those files when
adding a call or changing an existing one.

The API migration is merged into source. A merge does **not** establish that the
production API has been deployed or that all installed clients use it. Coordinate
the backend and first-party client release, and verify the deployed routes before
releasing a client that requires them. Older app versions are not supported by
this breaking cutover.

## Base URL and routes

Configure the HTTPS **origin** (scheme and host, with an optional port), for
example `https://api.example.com`. Append the paths in OpenAPI directly to
that origin. The current API has no `/api/v1`, `/api/v2`, or `/worker/v1` URL
prefix and provides no legacy route aliases. OpenAPI's `info.version` versions
the specification; it is not a URL segment.

| Consumer  | Origin setting                                         | Example current route     |
| --------- | ------------------------------------------------------ | ------------------------- |
| Android   | Gradle `-PauthApiUrl=https://api.example.com`          | `POST /auth/sessions`     |
| iOS       | Xcode `MUSICMUTE_API_BASE_URL=https://api.example.com` | `GET /jobs`               |
| Dashboard | `VITE_API_ORIGIN=https://api.example.com`              | `GET /admin/access`       |
| Worker    | `backendBaseUrl` in protected runtime JSON             | `GET /worker/logs/cursor` |

Debug or local fixtures may use an explicitly configured loopback HTTP origin
where each client permits it. A browser dashboard origin must be listed in the
backend's `CORS_ORIGINS`; CORS does not authenticate it. Native apps and workers
do not rely on CORS.

Routes name resources using lowercase kebab-case segments and plural collections
where appropriate. For example, create a job with `POST /jobs`, cancel one with
`POST /jobs/{id}/cancellations`, and request a result URL with
`POST /jobs/{id}/download-grants`. Use the exact method and path in OpenAPI;
renamed action routes have no fallback.

## Authentication and ownership

| Audience       | Credential and access rule                                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public         | Only operations marked public in OpenAPI; for example `GET /health/live`.                                                                                                                                                   |
| Mobile account | `Authorization: Bearer <Firebase ID token>`. Bootstrap with `POST /auth/sessions`; owner routes require the active account. The server selects the owner from the authenticated identity, not a caller-supplied account ID. |
| Administrator  | Firebase bearer token plus an active, verified Google administrator record and the permission listed for the operation. Some writes also require recent authentication, revision fences, and operation IDs.                 |
| Worker         | `Authorization: Bearer <worker credential>`, with enrollment, installation, or machine scope specified per operation. Machine credentials do not grant administrator access.                                                |

For the worker hint socket, first mint a single-use ticket with authenticated
`POST /worker/hints/tickets`. Connect to `/worker/hints/socket` with that ticket
in `Sec-WebSocket-Protocol`, as described by OpenAPI's `x-websocket-upgrade`.
Do not put the credential or ticket in the URL. Hints only wake reconciliation;
authenticated HTTP remains authoritative for jobs, leases, and commands.

Mobile apps upload and download media directly through short-lived signed S3
grants returned by the API; use the grant's exact URL and headers, without
attaching the Firebase bearer token to the S3 request.

## JSON, query, and pagination

- Send structured bodies as `application/json`. Public JSON property names and
  query names use `snake_case`: `installation_id`, `request_id`, `session_id`,
  and `next_cursor`, for example. CamelCase request keys are rejected. Keep
  language-specific model names inside the client and convert at the HTTP edge.
- Send each scalar query parameter once. Use the operation's documented bounds and
  enums. For `GET /jobs`, `limit` is 1–100 (default 20), `cursor` is the opaque
  pagination token, and `status` is an optional filter. Continue with the
  returned `next_cursor` until it is `null`; do not parse or manufacture cursors.
- The worker diagnostic cursor uses
  `GET /worker/logs/cursor?session_id=<uuid>&incarnation=<uuid>` and returns
  `acknowledged_sequence`. Both query values must be UUIDv4 values for the
  current machine session.
- Successful API JSON is converted to snake_case by the backend. Signed S3
  request headers and the worker release's signed metadata retain their own
  external naming contracts; copy those values exactly as supplied.

For example, an authenticated mobile history read is:

```sh
curl --fail-with-body \
  --header 'Authorization: Bearer <Firebase ID token>' \
  'https://api.example.com/jobs?limit=20'
```

The successful response contains `items` and `next_cursor`. Creating or
mutating a resource requires the exact request schema in OpenAPI. Where a
request body requires `request_id`, generate a UUIDv4 and preserve it for
reconciliation after an uncertain response; do not invent a new request ID for
an automatic retry of the same operation.

## Errors, budgets, and client behavior

Errors use RFC 9457 `application/problem+json`, with `type`, `title`, `status`,
`detail`, a stable MusicMute `code`, and `request_id`. Use `code` and HTTP
status for decisions; `detail` is a safe human-readable description, not a
machine contract. Include `request_id` when reporting a failure. API responses
set `Cache-Control: no-store` and `X-Request-Id`. If a proxy or network failure
does not return Problem JSON, handle the HTTP status or transport failure without
assuming that `code` is present.

```json
{
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "detail": "Conflict",
  "code": "CONFLICT",
  "request_id": "00000000-0000-4000-8000-000000000000"
}
```

The example illustrates the shape; each operation has its own documented codes
and details. A period quota conflict uses HTTP 409 and may include
`next_reset_at` (a UTC timestamp or `null`). An immediate rate limit uses HTTP
429 with `Retry-After` in seconds. Respect that delay; do not retry a quota
conflict as though it were an immediate throttle. Validation errors, expired
credentials, missing permissions, and unavailable dependencies have distinct
statuses in OpenAPI. Reconcile an ambiguous write through its documented
read-back or operation receipt before resending it.

## Rules for API changes

Before changing a route, payload, auth rule, or error, read the current
[Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
and the [MusicMute rule index](../backend-security/zalando-guidelines-index.md).
Relevant rules include root resource paths instead of a generic `/api` base
(#135, recommendation), no URL versioning (#115), snake_case query and JSON
names (#130 and #118), resource-oriented paths (#129 and #141), and standard
Problem Details errors (#176). Apply portable guidance to this product; the
committed OpenAPI and implementation define MusicMute's actual contract.

Update the OpenAPI operation, backend behavior, every first-party caller and
fixture, and the relevant docs together. Review authentication and ownership,
input bounds, status codes, pagination, and retry behavior. Add focused contract
tests for behavior changes. A change to source or docs alone does not prove a
production deployment or live client compatibility.
