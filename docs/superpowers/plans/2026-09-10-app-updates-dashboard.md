# MusicMute Release Dashboard Implementation Plan

> Dashboard execution is owned by the [full dashboard task package](../../tasks/full-dashboard/README.md). Its approved stack is React + TypeScript + Vite, Tailwind CSS + shadcn/ui, React Router, TanStack Query and Firebase Web Authentication. The full package supersedes the older dashboard source map, minimal UI scope, equal-access authorization and hosting steps below. Hosting is excluded; implementation remains paused until the user requests resumption and B18 passes.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let approved Google accounts upload APKs to S3, prepare English release notes, publish update rules, switch Android sources, and manage the admin allowlist.

**Architecture:** Add a small React/TypeScript SPA under `dashboard/`, served at `/admin/` by the existing backend. Firebase authenticates the identity, while every privileged request is authorized by the backend. Browser-to-S3 transfer avoids proxying APK bytes through NestJS.

**Tech Stack:** React, TypeScript, Vite, Tailwind CSS + shadcn/ui, React Router, TanStack Query, Firebase Web SDK, native fetch/XHR, Vitest, React Testing Library/MSW and Playwright. Lock compatible resolved versions during the authoritative D01 task.

**Spec:** [Design and contracts](../specs/2026-09-10-app-updates-design.md).

## Global Constraints

- Read the design and backend endpoint contract first. Do not invent additional authentication, release or S3 APIs.
- English dashboard and **English-only changelogs**. Mobile interface localization is separate.
- Google sign-in with one initial allowlisted owner; expandable list. No public registration into administrator access.
- Upload creates a draft; publish is an explicit separate action. Forced publication shows the scope and affected build threshold.
- S3 private; presigned grants expire; no Firebase Authorization header to S3. Never store service-account keys in frontend code.
- No production deployment, publishing, account mutation or cloud configuration during implementation without explicit authorization.
- No code changes in the planning turn. Preserve unrelated repository changes; no commits without a request.

---

## File structure and interfaces

Create `dashboard/package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `src/auth/{firebase,AdminSession}.tsx`, `src/api/{client,contracts}.ts`, `src/releases/{ReleaseList,ReleaseEditor,UploadPanel,PublishPreview,ReleaseHistory}.tsx`, `src/releases/{apk-hash.worker,upload}.ts`, `src/admin/AdminAccounts.tsx`, and colocated tests.

Use `firebase.ts` rather than `.tsx` if no JSX is present. Keep feature folders cohesive. Define the exact shared contract types in `contracts.ts`; a backend implementation change must update the shared fixtures, not silently diverge.

`adminRequest<T>(path: string, init?: RequestInit): Promise<T>` only calls the same-origin `/api/v1/admin` namespace and attaches the current Firebase ID token. `uploadApk(grant: {url: string; fields: Record<string,string>}, file: File, onProgress: (percent:number)=>void, signal: AbortSignal): Promise<void>` sends multipart data directly to the granted S3 host. It must never call `adminRequest` for S3.

## Task UPD-D01: Dashboard shell and Google admission

**Files:** Create the package/config/shell/auth/API files above, `src/auth/AdminSession.test.tsx`, `src/api/client.test.ts`, `playwright.config.ts`, `tests/auth.spec.ts` and `README.md`.

**Interfaces:** Consume `GET /admin/session`; expose authenticated `AdminSession` state to routes. States: restoring, signed-out, checking-access, allowed, denied, failed. API failures use `{status,code,message,retryAfter?}` without raw response/token logging.

- [ ] Add admission tests before the UI: no sign-in shows only login; Google success followed by 403 shows access denied; 401 retries token refresh once; revoked/removed admin loses access; login-popup cancellation is recoverable.
- [ ] Define package scripts `dev`, `build`, `typecheck`, `lint`, `test`, `verify`, `test:e2e`. `verify` runs typecheck, lint, unit tests and production build. Add only the dependencies listed in the tech stack and a small linter configuration; preserve the lockfile.
- [ ] Implement Google sign-in using existing Firebase project public web configuration. Use session-scoped persistence, then call `/admin/session`. Do not decide access by frontend email matching. Configuration failure displays a useful setup error without revealing secrets.
- [ ] Implement same-origin API transport with one controlled token-refresh retry; honor 429/503 and expose retry UI. Do not automatically replay non-idempotent publication after an uncertain response; read back the revision instead.
- [ ] Build an accessible shell with Releases, Settings/Publication, and Administrators navigation. Do not show protected release/admin data while admission is unresolved. Configure Vite base `/admin/` and a development proxy only for local work.

```tsx
// AdminSession.test.tsx fixture intercepts GET /admin/session with a 403.
render(
  <AdminSession>
    <div>Release management</div>
  </AdminSession>,
);
expect(await screen.findByText('Access denied')).toBeVisible();
expect(screen.queryByText('Release management')).not.toBeInTheDocument();
```

- [ ] Run `npm test -- src/auth/AdminSession.test.tsx src/api/client.test.ts` then `npm run build`. Add Playwright admission proof using local Firebase/API doubles, not the owner's production Google account.

**Acceptance:** The dashboard renders under `/admin/` and never exposes privileged data to an ordinary authenticated account.

## Task UPD-D02: APK upload, verification and draft editor

**Files:** Create `ReleaseList.tsx`, `ReleaseEditor.tsx`, `UploadPanel.tsx`, `apk-hash.worker.ts`, `upload.ts`, their tests, and `tests/releases.spec.ts`.

**Interfaces:** Consume create/edit/list/upload/confirm endpoints from B02/B03. Render server-owned artifact state. APK metadata is authoritative only after server verification; hash calculated in the browser is an upload condition, not security proof.

- [ ] Add UI tests for wrong extension, oversized file, user cancellation, expired POST, interrupted transfer, failed verification, server metadata mismatch and successful verified draft. A successful S3 upload must not enable Publish until confirmation reports `verified`.
- [ ] Hash the APK in a Web Worker so the UI stays responsive. A 256 MiB upper bound is enforced before reading; transfer the buffer rather than copying it. Allow cancellation between hash/upload/confirmation phases and discard stale callbacks when a different file is chosen.
- [ ] Implement multipart POST fields exactly as returned; add the file last and exclude Firebase Authorization. Display determinate byte progress, retry and grant renewal. Renewing an expired reservation never assumes a previous object is the current verified artifact.
- [ ] After upload call bounded confirmation. On 409 in-progress, read draft state with capped retries; on uncertainty fetch current state before submitting another confirmation. Show specific package/signature/checksum failure messages mapped from safe server codes.
- [ ] Build draft editor with platform, source, version/build (verified/read-only for APK), English changelog and App Store/Play URL when appropriate. Use plain text for changelog, with a live preview matching mobile structure. iOS is metadata-only; never display APK upload for iOS.
- [ ] Show immutable published releases read-only and create a new draft for a new build. Preserve unsaved changelog content when a transient upload/API error occurs.

```ts
expect(canPublish({ state: 'draft', artifactState: 'awaiting_upload' })).toBe(
  false,
);
expect(canPublish({ state: 'draft', artifactState: 'rejected' })).toBe(false);
```

Define `canPublish` in `src/releases/release-state.ts` with typed source-aware inputs; for store releases require complete validated metadata rather than an APK state. Add its tests in the same task.

- [ ] Run editor/upload/worker tests and `npm run test:e2e -- tests/releases.spec.ts`. Fake S3/API URLs locally; prove no Authorization header reaches the upload destination.

**Acceptance:** An administrator can prepare and verify an APK draft without publishing it, and can safely recover from interrupted uploads.

## Task UPD-D03: Publication, update source and administrator management

**Files:** Create `PublishPreview.tsx`, `ReleaseHistory.tsx`, `AdminAccounts.tsx`, `src/releases/ReleaseSettings.tsx`, their tests, and `tests/publication.spec.ts`.

**Interfaces:** Consume preview/publish/withdraw/accounts endpoints from B01/B04. Show current policy and allowlist revisions; retain `expectedRevision` from the viewed state for each write.

- [ ] Add tests for stale preview (409), forced minimum above available target, alternate channel missing, denied admin changes, last-admin removal and uncertain publish response. A retry after an uncertain response must read back policy before deciding whether another write is needed.
- [ ] Implement Android source selector **Direct APK / Google Play**, common minimum-supported build, and each channel's selected target. Explain the user impact with concrete installed-build examples. Do not offer direct APK for Play distributions or for iOS.
- [ ] Preview optional versus forced results, English changelog, availability declaration and affected installations. Publish requires an explicit final button naming the selected platform/build and mandatory threshold. No upload-complete auto-publish.
- [ ] Show revisioned publication history and an explicit withdrawal/replacement action with a preview. A recovery action can lower the minimum only through the backend withdrawal contract; it cannot request a binary downgrade.
- [ ] Implement allowlist listing and add/remove by verified Google email. Backend resolution owns the UID. Show clear failure for non-Google/unverified accounts, duplicate entry, stale list and removing the last admin. Do not place administrator emails in analytics logs or public page data.

```tsx
// publication.spec.ts local fixture publishes revision 5 while the form holds 4.
await page.getByRole('button', { name: 'Publish release' }).click();
await expect(
  page.getByText('Release settings changed. Refresh the preview.'),
).toBeVisible();
```

- [ ] Run `npm run verify` and `npm run test:e2e`. Verify keyboard/focus behavior, upload loading states and narrow-screen usability. Coordinate production asset packaging with V01; do not deploy.

**Acceptance:** The owner can manage releases, switch eligible Android update destinations and expand the administrator list with backend authority and visible conflict handling.
