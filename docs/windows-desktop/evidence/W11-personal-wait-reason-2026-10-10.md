# W11 — Personal and Chrome admission waiting presentation

Date: 2026-10-10, Africa/Cairo. Production source and portable composed fixtures;
no Windows native helper, GPU/model execution, browser/Electron launch, account,
enrollment, claim, installer or live endpoint was used.

## Concrete gap and receiving change

The actual broker knew accepted-worker handover, physical guard contention and
reservation recovery, but its pending acquire reply exposed only `pending:true`.
The real personal runner/controller and Chrome JOB projection therefore showed
generic preparation. The receiving path now carries only a fixed wait reason:

`'waiting-for-worker' | 'gpu-busy' | 'recovering'`.

The existing protected `gpu-admission` reply adds optional `waitReason` while
pending. No request action, HTTP endpoint, status polling mechanism, scheduler,
GPU selection, native guard or lease authority was added. SID/logon/PID/birth,
GPU/LUID/ordinal, guard/lease nonce and other owners' work remain private.

| Layer                                         | Production source / behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Meaningful proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual broker to private reply                | [session-admission.ts](../../../windows-desktop/src/main/admission/session-admission.ts) subscribes to the existing `WindowsGpuBroker` events. Changed fixed reason wakes the pending exchange promptly. Per-request last reason keeps unchanged exchanges held through the existing twenty-second heartbeat; listener/deadline are removed on settlement.                                                                                                                                                                              | [session-admission.test.ts](../../../windows-desktop/tests/session-admission.test.ts): real persisted recovery remains fenced, immediate sanitized reply, second acquire stays held until the existing deadline and leaves zero timers.                                                                                                                                                                                                                                                                                                  |
| Role-owned receiving gateway                  | `createRoleGpuGateway.acquire(request,signal,onWait?)` retains exact request/generation/role/qualified GPU binding, strictly accepts only the three reason strings and deduplicates callbacks. Aborted owners cannot receive late wait events.                                                                                                                                                                                                                                                                                          | [admission-wait-reason.test.ts](../../../windows-desktop/tests/admission-wait-reason.test.ts): actual `SessionClient`/gateway transport fixture; duplicate/legacy-omitted replies, unknown uppercase secret/object/number rejection and cancelled late reply.                                                                                                                                                                                                                                                                            |
| Native-role admission to runner/controller    | [BrokerPersonalAdmission](../../../windows-desktop/src/main/personal/broker-admission.ts) forwards the optional callback. [DirectmlPersonalRunner](../../../windows-desktop/src/main/personal/runner.ts) emits preparation progress with the reason and clears it after actual permit return. [PersonalProcessingController](../../../windows-desktop/src/main/personal/controller.ts) permits reasons only during preparation, and clears on ordinary progress, grant, cancellation, scope retirement, recovery and terminal outcomes. | [admission-role-composition.test.ts](../../../windows-desktop/tests/admission-role-composition.test.ts): real bank/broker/private clients/router/role controls/admission/runner/controller; accepted fleet/native cleanup before priority, busy guard with no spinning requests, late-grant cancellation with zero model command. [personal-controller.test.ts](../../../windows-desktop/tests/personal-controller.test.ts): A→B retirement prevents old progress/publication; recovered pair cannot restore old waiting state.          |
| Private full snapshot to desktop presentation | Optional `PersonalJobView.waitReason` is additive; legacy omission/null remains ordinary preparation. [PersonalAgentClient](../../../windows-desktop/src/main/personal/session-port.ts) clears unreviewed or stale reasons in job/full-job replies. Main's existing event-owned personal snapshot retains the field.                                                                                                                                                                                                                    | [personal-events.test.ts](../../../windows-desktop/tests/personal-events.test.ts): actual protected client reply parser admits only fixed reasons for preparation and strips private-shaped/terminal/other-stage values.                                                                                                                                                                                                                                                                                                                 |
| Actual Windows UI                             | Existing Main personal binding feeds [PersonalPanel](../../../windows-desktop/src/renderer/personal-view.tsx) and [PreparingPlayerPanel](../../../windows-desktop/src/renderer/preparing-player-view.tsx). Root's receiving implementation localizes reasons in EN/AR only for preparing/preparation, and keeps waiting progress indeterminate.                                                                                                                                                                                         | [personal-view.test.tsx](../../../windows-desktop/tests/personal-view.test.tsx) and [preparing-player-view.test.tsx](../../../windows-desktop/tests/preparing-player-view.test.tsx): waiting transitions, stale numeric fraction, cancellation and no premature audio. No interactive Windows UI claim.                                                                                                                                                                                                                                  |
| Actual shared Chrome reply and controls       | [WindowsBrowserService.sendJob](../../../windows-desktop/src/main/browser/service.ts) projects validated wait reason into the existing bounded `JobSnapshot.stage` and omits numeric progress while waiting. No new browser field/version. Shared [localizedStage](../../../chrome-extension/src/extension/i18n.ts), popup and content render EN/AR; content suppresses even stale received numeric fractions and preserves cancellation/paused original video.                                                                         | [browser-provider-service.test.ts](../../../windows-desktop/tests/browser-provider-service.test.ts): actual provider service emits safe JOB stages without private reason field/identity or numeric progress. [popup-platform.test.ts](../../../chrome-extension/tests/popup-platform.test.ts) and [content-ad-mute.test.ts](../../../chrome-extension/tests/content-ad-mute.test.ts): actual received Windows/Mac popup and content handlers, EN/AR wait states, paused/no-vocals/cancel behavior and ordinary Mac separation retained. |

The reason is presentation only. It cannot grant inference, change saved worker
intent, terminate accepted fleet jobs, relax actual guard/tree cleanup or increase
backend capacity. A wait timeout is not an owned-tree exit proof.

## Compatibility and safety review

The Zalando API guideline preflight was applied using the current
[official guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-10: rules 104 (authentication/authorization), 106/107 (compatible
extension), 195 (reviewable event schema), 200 (avoid sensitive event data), 214
(duplicate robustness) and 209 (event compatibility). This is an authenticated
private named-pipe protocol, so HTTP URL/status/OpenAPI transport requirements
do not apply. Existing private camelCase and public browser stage conventions
remain; no REST protocol was invented.

The field is ephemeral, not a stored permit or restored admission receipt.
Unknown pending reason values fail with fixed `GPU_COORDINATION_UNAVAILABLE`;
unknown/stale public snapshot reasons become null. Owner/generation checks and
current qualified GPU validation still precede actual effects. An unknown raw
error cannot become a wait label, and callbacks after cancellation are ignored.

## Executed checks

- Final desktop broker/bank/certificate/gateway/runner/controller/private
  snapshots/browser service/Personal/Preparing UI slice: **98 tests / 12 files
  pass**, 03:11:57, 4.15s.
- Earlier broad run: 90 pass / 1 fail. The existing certificate test expected
  its first acquire to remain held; it now receives the immediate busy reason.
  The updated fixture explicitly consumes that pending reply, submits the same
  held request and requires `GPU_WAIT_CANCELLED` after the exact whole-role
  certificate before a replacement owner receives a permit. Final slice above
  verifies this without weakening the cancellation/ownership invariant.
- Full shared Chrome `npm test`: **2,341 pass / 4 existing skips / 83 files**,
  03:09:56, 35.50s. The focused received popup/content/i18n run also passed
  252 cases / 3 files. No skipped case is reported as executed acceptance.
- Whole desktop `npm run typecheck` and `npm run lint`: exit 0; lint 522 files,
  zero warnings/errors. Whole shared `tsc --noEmit` and `npm run lint`: exit 0;
  lint 224 files, zero warnings/errors.
- Desktop `npm run build` and `npm run test:package-fixtures`: exit 0; two actual
  renderer/preload source-boundary fixtures pass. Source bundling does not launch
  the Windows app or execute a GPU model.
- Owned source/test formatting: all nineteen matched files pass. The first
  scoped lint found one unused local fixture variable; it was removed and the
  final scoped/component lint passed. Whole shared `npm run format:check` also
  returned exit 0.
- Evidence formatting and local references: Prettier passes; all nineteen local
  source/test references resolve.

## Remaining Windows proof

- [ ] Exercise actual app/Chrome/accepted fleet handover and cancellation with
      the native keeper/Job tree, recording no model overlap and accurate simple
      waiting labels on both supported Windows versions.
- [ ] Test real cross-user GPU busy, recovery/certificate events, driver/device
      changes, broker/helper crashes and logout while a reason is visible.
- [ ] Verify EN/AR interactive accessibility and first-play/indeterminate progress
      on the installed shared extension and packaged Windows application.

Source receiving behavior is complete for this scoped return. W11's other
authority/native acceptance rows remain under their own evidence; this record
does not close them from presentation fixtures alone.

### Later Root receiving and acceptance reconciliation

The actual waiting label remains a pending state. A terminal `GPU_BUSY` refusal
now asks the user to wait for current work and try again; it does not promise
automatic continuation of a failed job. The exact terminal/stale-wait/cancel/
no-audio/localization/admission receiving slice passed **31 tests/five files at
03:13:41**. Whole Desktop TypeScript, extended owned lint24, source build and
both boundaries passed after the correction. These counts overlap the earlier
98-test slice; the final W33 combined regression is still separate.

Root also bound the newly audited native fault procedures into the actual
acceptance manifest definitions/revisions and TEST-DATA, including same-bytes
manifest replacement birth, private partial/marker ACK loss, no-GUI maintenance
wake/login intent, all-guardian loss/secondary adapters, Share callback uncertainty
and downloaded installer/app-local DLL evidence. Those are unrun W34 procedures,
not additional native test results.
