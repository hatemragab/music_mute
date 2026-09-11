# Support-assisted MusicMute account deletion

Draft dated 2026-09-10. No production deletion or outbound customer communication was performed. The authenticated operator procedure requires an explicit request and verified ownership; neither public page exposes it.

## Public configuration

The existing backend serves `GET /delete-account` and `GET /privacy` outside `/api/v1`. Both are public, server-rendered HTML with no client scripts, account lookup or unauthenticated deletion form. The deletion page has an actionable support-email link and copyable instructions that work without installing the app.

The backend remains usable without these optional fields, but both pages return HTTP 503 until all publication information is supplied:

| Field | Required publication value |
| --- | --- |
| `PUBLIC_SUPPORT_EMAIL` | Actual monitored mailbox; plain valid email address, no URL or mail headers |
| `PUBLIC_DEVELOPER_NAME` | Actual developer identity matching the listing |
| `PUBLIC_DELETION_TIMEFRAME` | Supported completion expectations, including when measurement begins and escalation handling |
| `PUBLIC_RETENTION_NOTICE` | Actual log, provider, backup and legitimate retention scope with finite expiry periods |

Configured prose is HTML escaped; email configuration rejects unsafe characters and header injection. No contact, public domain or deletion deadline is invented. Populated fields prove only configuration, not mailbox monitoring or supported promises.

Before separately authorized publication, verify the intended domain/certificate, both routes, keyboard/text accessibility, email destination and fallback address, privacy scope and retention copy. Exercise the external request workflow without signing in. Record final URLs only after publication and live verification, then configure those exact URLs in both apps and the store.

## Receive and verify a request

1. Record the request in the restricted support system with minimum necessary metadata and a case reference. Keep personal data out of this repository and general logs.
2. Treat the email as a request to begin verification. A supplied email address, sender header, display name, Firebase UID or knowledge of profile details alone does not authorize deletion.
3. Use the approved identity-provider/recovery procedure to verify account control. Check the result through trusted provider records, not screenshots or tokens pasted into email. The procedure must work without reinstalling the app. A documented, exercised verification/recovery process is a release prerequisite; this draft does not invent a deployed support login service.
4. Never request passwords, ID/access tokens, recovery codes or audio attachments by email. Handle unsolicited credentials through restricted incident procedures; do not reuse or log them.
5. Resolve the verified Firebase UID to its backend user and independently check the pairing. Confirm that the request asks for account deletion, explain scope/timing, and retain the verification outcome in the restricted case record.

## Authenticated operator procedure

Use the established trusted operator environment and service identity. Exercise the workflow on an isolated disposable account before production use.

Prepare a private JSON file outside the repository, readable only by the operator, containing exactly `userId` (verified MongoDB user ObjectId) and `firebaseUid` (verified Firebase UID). These are personal identifiers. Do not put them in shell history, source control, PRs or general support chats. The CLI rejects extra properties and verifies the pairing.

From `backend/`, after building the reviewed code:

```sh
npm run ops:auth -- delete-account --dry-run --file /private/operator/request.json
```

An explicit apply operation additionally requires an ownership attestation:

```sh
npm run ops:auth -- delete-account --apply --ownership-verified --file /private/operator/request.json
```

These commands are instructions, not evidence of a production run. Do not execute apply without the request, ownership proof and action authorization. The flag attests to an operator check; it does not perform identity verification. Keep actual identifiers out of command arguments.

Store the returned request reference in the restricted case record. Repeated requests use the same durable lifecycle, including verified support requests for disabled accounts. Never update MongoDB status directly, delete Firebase first, remove the deletion marker early, or bypass worker/storage cleanup.

## Acceptance and completion

Acceptance durably blocks normal account work. Background cleanup revokes sessions, cancels jobs, fences late completions, resolves outstanding signed grants, removes account-owned storage versions/records and removes Firebase identity. Inspect the durable stage and retry conditions through authorized backend operations. An HTTP 202, timeout, absent session or failed login is not completion proof.

A lost or expired Z440 lease does not prove its process stopped. Preserve quarantine/fencing and obtain termination proof or approved containment before closing cleanup. Include worker temporary inputs/results in evidence. Never auto-unlock a lost lease to make deletion appear finished.

The public pages disclose a 24-hour pseudonymous security replay fence after deletion. Verify its finite expiry in the release backend. Inventory log, database-backup, storage-provider and support-case/mailbox retention separately and reflect the actual finite periods in the configured notice. Do not describe backups as instantly erased. Restore procedures must replay deletion restrictions before exposing restored data.

The receiving app purges its private account data after acceptance. Imported originals and user-exported copies remain under user control. Offline installations may retain copies until reconnection or local app-data removal; the API cannot erase an offline device immediately.

If providers or cleanup fail, preserve the request and retry state. Escalate using a restricted reference and safe error code, never bearer tokens, signed URLs or media. Send status messages only through an authorized support channel. Confirm completion only after backend and provider/worker checks prove it, explaining any legitimate retained data.

## Required operator evidence before release

- Named developer, monitored mailbox and staffing/escalation owner.
- Tested ownership-verification/recovery path usable without the app.
- Supported timeframe and actual finite backup/log/provider/support retention.
- Tested restore-time deletion replay.
- Disposable-account proof through the operator lifecycle.
- Published, live-verified public pages and matching mobile/store URLs.

The external email route is supported by [Google Play account deletion guidance](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en), checked 2026-09-10. Privacy disclosures must accurately reflect data collection, use, sharing and retention; see [Google Play User Data](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en), checked the same date.
