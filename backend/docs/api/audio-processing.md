# Audio job API

This document describes the temporary clean-slate contract for authenticated
audio-job clients. New processing is unavailable while the execution architecture
is redesigned. Existing history and completed results remain accessible.

All paths are relative to `/api/v1`, require the current Firebase bearer token,
and return `Cache-Control: no-store` where configured by the controller.

## Available history and result operations

| Method and path               | Behavior                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /jobs`                   | Lists the current user's retained job history with opaque cursor pagination.                 |
| `GET /jobs/:id`               | Returns one owner-scoped retained job.                                                       |
| `PATCH /jobs/:id`             | Renames a retained job.                                                                      |
| `POST /jobs/:id/cancel`       | Cancels a cancellable retained job.                                                          |
| `POST /jobs/:id/download-url` | Issues a short-lived owner-scoped download grant for an available input or completed result. |
| `DELETE /jobs/:id`            | Hides the job and schedules its owned storage cleanup.                                       |

Downloads remain private and version-pinned. Clients must treat returned grants
as short-lived capabilities, avoid logging them, and use the authoritative job
record for availability.

## Temporarily unavailable operations

The following authenticated routes remain as compatibility boundaries and return
HTTP 503 with code `PROCESSING_UNAVAILABLE`:

- `POST /jobs`
- `POST /jobs/:id/retry`
- `POST /jobs/:id/upload-url`
- `POST /jobs/:id/upload-complete`

Clients should preserve local input, show the server message, and wait for a later
approved API contract before offering a retry. No machine-execution endpoint is
part of the current API.

## Validation boundary

Local unit and isolated integration tests prove controller, authentication,
history, download, cancellation, deletion, and unavailable-response behavior.
They do not prove live Firebase, S3, notification, or production deployment.
