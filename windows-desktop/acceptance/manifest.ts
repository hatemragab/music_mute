export type AcceptanceRisk =
  | "isolated-native"
  | "installed-state"
  | "live-account"
  | "destructive"
  | "publication";
export interface AcceptanceCase {
  id: string;
  revision: number;
  task: string;
  points: readonly string[];
  risk: AcceptanceRisk;
  action: "native-build" | "native-ctest" | "manual";
  prerequisites: readonly string[];
  procedure: string;
  expected: string;
}
const featureRows: readonly [string, string, string, string][] = [
  [
    "P01",
    "W04",
    "shell",
    "Packaged Home/Library/Account/Setup/Worker/Diagnostics/Settings navigation, signed-out imports and visible shell failures",
  ],
  [
    "P02",
    "W02",
    "shared-contracts",
    "Same shared contracts/extension source; strict receiver validation, current Mac compatibility and untouched legacy Windows service",
  ],
  [
    "P03",
    "W07",
    "gpu-qualification",
    "Native Win10 19045 and Win11 AMD64; real model/recipe placement on physical DirectML, no CPU fallback, changed driver/device/ordinal recovery",
  ],
  [
    "P04",
    "W12",
    "personal-imports",
    "Supported audio/video, Unicode/large paths, public YouTube 20-minute limit, rights/mode review, cancellation/retry and source-timeline identity",
  ],
  [
    "P05",
    "W08",
    "prepare",
    "Fresh approved downloads, each stage/progress, resume/cancel/repair, corrupt/low-disk/crash recovery and no false Ready",
  ],
  [
    "P06",
    "W31",
    "fresh-prerequisites",
    "Clean standard-user profile with no developer tools/global VC runtime; actual signed app/helper, pinned Node/Python/FFmpeg/model/fixture acquisition, genuine app-local DLL closure/notices and isolated prerequisite probe; retained external runtime",
  ],
  [
    "P07",
    "W09",
    "startup-receipt",
    "Cold/warm launch with exact current DPAPI receipt/GPU binding, bounded startup, no model inference or full model hash on ordinary warm launch",
  ],
  [
    "P08",
    "W12",
    "guest-local",
    "Signed-out Prepare and local file/YouTube processing, offline verified guest playback/export, guest ownership across account switches and local behavior when optional account/shared services fail",
  ],
  [
    "P09",
    "W13",
    "processing-mode",
    "Persisted local/cloud choice, current allowance/rights fences, deliberate manual Chrome saved-cloud Start and separate non-billing desktop review handoff",
  ],
  [
    "P10",
    "W14",
    "account",
    "Google/email authentication, verification/cooldown, recovery, linked methods/recent auth, devices, sign-out/everywhere/delete/recover with explicit designated-account authorization",
  ],
  [
    "P11",
    "W15",
    "usage-realtime",
    "Full-snapshot usage/policy/reconnect gaps, quota/stale account denial, native-only visibility policy without cancelling jobs or hiding Chrome controls",
  ],
  [
    "P12",
    "W16",
    "library",
    "Guest/account merge, metadata/thumbs/durations, filters/sorts/star/hide/restore/rename/delete, pinned originals/voice/offline/export/native share; ShareCompleted, ShareCanceled and lost/unknown callbacks with exact quiesced receipt/file birth, retired HWND owner and restart inspection without showing Share again",
  ],
  [
    "P13",
    "W17",
    "history",
    "Genuine starts/repeats/AB counted once, seek/buffer/source switch not doubled; aliases/scopes, clear/corrupt/future-history recovery",
  ],
  [
    "P14",
    "W18",
    "player-queue",
    "Real original/voice listening, exact comparison/standalone trim, seek/rate/volume/mute, repeat/shuffle, queue add/play-next/move/remove/clear and duplicate-ended protection",
  ],
  [
    "P15",
    "W19",
    "advanced-listening",
    "Sleep presets/custom/cancel, track-change cancellation, scoped AB/bookmarks and bounded CPU silence analysis with retained-sample seek maps",
  ],
  [
    "P16",
    "W20",
    "outbox",
    "Captured owner/source pairs, automatic save independent of playback, crash/restart retry/discard/auth-required and account A work never assigned to B",
  ],
  [
    "P17",
    "W21",
    "reuse",
    "Exact guest cache/account/community hit before acquisition; source/model/recipe/hash/timeline checks, original-only miss behavior and bounded optional-service failure",
  ],
  [
    "P18",
    "W22",
    "storage",
    "Real free-space/budget, crash-safe writer journals, active file/pins, cache/artifact LRU and long-run bounds; exact native partial/marker cleanup preserves replacements/unbound live or unknown old Node/uncertain handoff; normal bound-role cleanup needs actual inference/tools idle, and reservations survive deletion/certificate ACK loss",
  ],
  [
    "P19",
    "W23",
    "fleet-onboarding",
    "Current Google/admin permission, backend-approved fixture/profile and GPU eligibility; explicit authorized enrollment preserving distinct machine credentials",
  ],
  [
    "P20",
    "W24",
    "fleet-controls",
    "Enable/start/stop/pause/drain/resume/restart/remove, saved intent vs observed state, accepted-job drain, capability loss and account-independent role",
  ],
  [
    "P21",
    "W25",
    "fleet-advanced",
    "Doctor, investigate, logs/bundle, local-file and capacity benchmarks, prepared-release identity, bounded maintenance/cancel and original backend approval",
  ],
  [
    "P22",
    "W11",
    "gpu-coordination",
    "One physical GPU authority across personal/Chrome/fleet and simultaneous logons; exact post-claim admission, accepted-job drain before handover, Waiting for worker/Busy/cancellation, stale-owner recovery and no overlapping inference; separately qualified secondary/primary roles and current approved secondary after reboot are tested independently",
  ],
  [
    "P23",
    "W26",
    "chrome-registration",
    "Shared host/key/ID and both owned HKCU views; generation-bound manifest repair/removal with same path/bytes but replaced birth, each registry transaction/manifest publication interruption and lost commit ACK/restart; stale receipts preserve foreign/replacement generations; actual Unicode stdio without log contamination",
  ],
  [
    "P23",
    "W27",
    "chrome-parity",
    "SPA/start/cancel/progress/queue/synchronized voice, UI-closed local/manual cloud, cache-only recovery, publication-on-exact-first-play and original peer isolation",
  ],
  [
    "P24",
    "W28",
    "preferences",
    "Complete accepted Mac settings, theme/accent/text/language/RTL, source/mode/player/storage/login defaults, last section and owner-correct state through relaunch",
  ],
  [
    "P25",
    "W10",
    "login-lifetime",
    "Window close versus confirmed awaited personal Quit versus explicit Worker Stop, optional tray independence and account-independent fleet; GUI-absent next login restores running/paused/draining and preserves stopped, current boot/hive invalidates GPU proof for installed-only requalification; Prepare mutex/ANY maintenance WAL phase fences simultaneous Chrome/login/new-role launches",
  ],
  [
    "P27",
    "W29",
    "updates",
    "App/runtime/model signed transitions, every crash/ACK-loss step, actual idle handover, approved active-fleet overlay, rollback and preserved identities/outboxes",
  ],
  [
    "P28",
    "W30",
    "diagnostics",
    "Current-user vault and native identity, sandbox/validated IPC, visible setup/account/worker diagnosis, bounded local sanitized logs/export and preserved fleet reporting boundaries without private data",
  ],
  [
    "P29",
    "W31",
    "installer",
    "Signed downloaded website candidate from isolated release bucket, MOTW/SmartScreen plus separate timestamp/revocation/reputation observations, upstream model/notices, fixed current-user destination/asInvoker/native x64+19045 guards; ordinary uninstall preserves data/runtime/Run and approved worker next-login operation; no forced accepted-work kill; Store remains later",
  ],
  [
    "P24",
    "W28",
    "accessibility",
    "English/Arabic RTL, all controls/keyboard focus/screen reader/high contrast/DPI/font scaling and friendly visible error labels",
  ],
  [
    "P26",
    "W32",
    "cross-product",
    "Windows account/device/platform/build/profile, enrollment/update policy and dashboard projections with compatible Mac/mobile/web/legacy workers and raw WebSocket full snapshots; deployed-service proof is separately authorized",
  ],
  [
    "P30",
    "W34",
    "release-acceptance",
    "Per-target OS/vendor coverage, cold/warm performance, long playback/worker stress, signed candidate inventory and explicit remaining matrix/publication gates",
  ],
];
export const ACCEPTANCE_CASES: readonly AcceptanceCase[] = [
  {
    id: "native-build",
    revision: 2,
    task: "W03",
    points: ["P02", "P03"],
    risk: "isolated-native",
    action: "native-build",
    prerequisites: [
      "authorized-connected-Windows",
      "existing-approved-MSVC-SDK-CMake",
      "independently-approved-QA-tool-guard",
    ],
    procedure:
      "Approved QA guard runs fixed CMake -A x64 in an isolated owned folder, builds actual helper/session/Chrome proxy and fixture binaries, then describes actual native host; each tool action must return exact request-bound whole-Job-zero receipt, never parent-close-only cleanup.",
    expected:
      "Actual native AMD64/workstation/build matches target, current compiled source hashes bound; compile/link exit zero. This does not establish installed/signature/GPU inference proof.",
  },
  {
    id: "native-security-fixtures",
    revision: 3,
    task: "W03",
    points: ["P02", "P22", "P28"],
    risk: "isolated-native",
    action: "native-ctest",
    prerequisites: ["native-build"],
    procedure:
      "QA-guarded CTest runs isolated JSON/DPAPI/current-SID ACL/pipe/PID birth/Job and protocol fixtures plus GUID-only unsafe Global DACL/type squatting, watchdog-first/two-guardian loss, generation-bound registration transaction and partial/marker cleanup faults; confirmed whole-tool Job zero, no installed account/data/profile.",
    expected:
      "CTest has real tests and exit zero on this exact Windows target; no native result inferred from Mac parser or simulated adapters.",
  },
  ...featureRows.map(([point, task, id, procedure]): AcceptanceCase => ({
    id,
    revision: [
      "fresh-prerequisites",
      "library",
      "storage",
      "gpu-coordination",
      "chrome-registration",
      "login-lifetime",
      "installer",
    ].includes(id)
      ? 3
      : 2,
    task,
    points: [point],
    risk:
      point === "P10" || point === "P19"
        ? "live-account"
        : point === "P30"
          ? "publication"
          : "installed-state",
    action: "manual",
    prerequisites: [
      "native-security-fixtures",
      "reviewed-signed-candidate",
      "authorized-disposable-media-profile",
    ],
    procedure,
    expected:
      "Every corresponding FEATURE-ACCEPTANCE and owning task Windows checkbox has separately recorded observed success; failed/unrun branches remain pending, with cleanup verified.",
  })),
  ...(
    [
      [
        "personal-quit-export-cleanup",
        "W04",
        "Hold a window-owned export writer and source pin, reject one cleanup, close/Quit/reopen the window and reply to an old dialog; exact old cleanup remains awaited/retryable, replacement owners are untouched and Chrome/fleet continue.",
      ],
      [
        "runtime-repair-crashes",
        "W08",
        "Corrupt the disposable owned final runtime, interrupt every stage/backup/activation rename and lose an acknowledgement; recover only journal-bound exact births under actual Prepare/retired authority, preserve unknown bytes and safely retire the old backup before another Repair.",
      ],
      [
        "cache-deletion-lost-ack",
        "W22",
        "Race directory/leaf replacement and pins during cache deletion; separately replace partial/marker/header generations, hold unbound live/unknown old Node or child handoff/launch ACK and lose deletion/certificate ACK. Normal exact bound-role marker cleanup requires actual inference/tools idle; restart requires whole-Job proof. No suffix/PID-absence cleanup or early freed-space/idle success.",
      ],
      [
        "native-peer-isolation",
        "W03",
        "Another standard SID/remote peer, changed PID birth, squatted pipe/mutex, unsafe ACL/reparse/ADS/hardlink and foreign registry binding are denied; replace manifest with identical bytes/new birth and interrupt registry/manifest transactions. Stale protected prefix cannot adopt/remove the foreign generation.",
      ],
      [
        "sid-second-logon",
        "W10",
        "Keep first same-SID login active, open simultaneous second login before Host/ticket/bootstrap restore; second fails visibly and cannot replace first account/session/shared vault state.",
      ],
      [
        "gpu-guardian-crashes",
        "W11",
        "Independently kill Node/helper/Job guardian/GPU keeper/watchdog while descendants run, including watchdog-first, multiple guardian loss and ALL-reference simultaneous loss/logout. Another authorized SID/session remains busy until actual whole-tree zero; GUID-only CTest is not proof of real Global multi-user behavior.",
      ],
      [
        "gpu-handover-races",
        "W11",
        "Race personal cancellation after grant, accepted fleet drain, model preload and broker restart; separately test independently qualified secondary fleet/primary personal and current approved secondary after reboot. No duplicate inference, CPU fallback, forced accepted-job cancellation or stale grant.",
      ],
      [
        "ipc-event-concurrency",
        "W10",
        "Hold 20-second events during submit/cancel/Stop/account fence; final actual personal-activity wake with no GUI watcher advances maintenance only after real cleanup. Race Prepare mutex and EVERY protected maintenance phase against Chrome/login/new-role starts; prompt authenticated replies/one-use tickets/full snapshots without HTTP polling.",
      ],
      [
        "chrome-cold-cloud",
        "W27",
        "UI closed and no local Prepare/GPU: deliberate manual saved-cloud Start uses sole account/usage/realtime authority, preserves original browser peer and plays validated synchronized media.",
      ],
      [
        "publication-owner-proof",
        "W27",
        "Attempt wrong peer/job/video/vocal SHA, copied owner UUID and premature playback notifications; only exact original completion plus real first voice playback releases a deferred contribution once.",
      ],
      [
        "installer-lost-ack",
        "W29",
        "Interrupt each suspended-monitor/installer certificate/ACK step; recover only exact PID/thread birth/pin/publisher and never relaunch/rollback unknown prior outcome.",
      ],
      [
        "update-power-faults",
        "W29",
        "Power/network/low-disk/open-file/antivirus faults at each WAL stage; verified old or new executable/model/approved fleet proof returns without identity/outbox loss.",
      ],
      [
        "explicit-purge-revoke",
        "W31",
        "Separately authorized purge or fleet revoke; exact confirmation/ownership, legacy-service coexistence and no unrelated-user/data deletion.",
      ],
    ] as const
  ).map(([id, task, procedure]): AcceptanceCase => ({
    id,
    revision: [
      "cache-deletion-lost-ack",
      "native-peer-isolation",
      "gpu-guardian-crashes",
      "gpu-handover-races",
      "ipc-event-concurrency",
    ].includes(id)
      ? 2
      : 1,
    task,
    points: [],
    risk: id === "explicit-purge-revoke" ? "destructive" : "installed-state",
    action: "manual",
    prerequisites: ["native-security-fixtures", "explicit-case-authorization"],
    procedure,
    expected:
      "Actual authority/process/Job/lease observations and bounded redacted evidence establish the stated denial/recovery; cleanup is confirmed separately.",
  })),
];
