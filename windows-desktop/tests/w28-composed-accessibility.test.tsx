// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  getRoles,
  queryAllByRole,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountPanel } from "../src/renderer/account-view.js";
import { LibraryPanel } from "../src/renderer/library-view.js";
import { PreferencesPanel } from "../src/renderer/preferences-view.js";
import { StoragePanel } from "../src/renderer/storage-view.js";
import { OutboxPanel } from "../src/renderer/outbox-view.js";
import { DiagnosticsPanel } from "../src/renderer/diagnostics-view.js";
import { ConsumerUpdatePanel } from "../src/renderer/update-view.js";
import { WorkerAdvancedPanel } from "../src/renderer/worker-advanced-view.js";
import { WorkerPanel } from "../src/renderer/worker-view.js";
import { PlayerPanel } from "../src/renderer/player-view.js";
import { ModalDialog } from "../src/renderer/dialog.js";
import { setLanguage, t } from "../src/renderer/i18n.js";
import { DEFAULT_PREFERENCES } from "../src/shared/preferences-contracts.js";
import {
  DEFAULT_LIBRARY_QUERY,
  type LibraryView,
} from "../src/shared/library-contracts.js";
import type { FleetAdvancedUiCommand } from "../src/shared/contracts.js";
import type { FleetAdvancedView } from "../src/shared/fleet-advanced-contracts.js";
import type { StorageView } from "../src/shared/storage-contracts.js";
import type { ConsumerUpdateView } from "../src/shared/update-contracts.js";
import type { PlaybackView } from "../src/shared/playback-contracts.js";
import { diagnosticReport } from "../src/main/diagnostics/projection.js";
import { diagnosticIdentity } from "./diagnostics-fixtures.js";
import { accountView } from "./fleet-fixtures.js";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  setLanguage("en");
  vi.restoreAllMocks();
});
const machineId = randomUUID(),
  token = randomUUID(),
  requestId = randomUUID();
const storage: StorageView = {
  state: "ready",
  errorCode: null,
  budgetBytes: 2_000_000_000,
  voicesBytes: 0,
  reservedVoicesBytes: 0,
  freeBytes: 10_000_000_000,
  overBudget: false,
  lowSpace: false,
  categories: [],
  lastCleanup: null,
};
const update: ConsumerUpdateView = {
  phase: "available",
  scope: "app-only",
  available: {
    app: { version: "0.2.0", sha256: "a".repeat(64) },
    runtime: { version: "0.2.0", sha256: "b".repeat(64) },
    model: { version: "1.0.0", sha256: "c".repeat(64) },
  },
  required: false,
  automaticDiscovery: false,
  problem: null,
};
const library: LibraryView = {
  state: "ready",
  accountState: "signed-out",
  revision: 1,
  errorCode: null,
  query: DEFAULT_LIBRARY_QUERY,
  total: 1,
  nextCursor: null,
  visibleIds: ["local:one"],
  tracks: [
    {
      id: "local:one",
      jobId: null,
      title: "Long mixed عربي source",
      sourceKind: "file",
      videoId: null,
      durationSeconds: 60,
      sourceDurationSeconds: 60,
      trimEnabled: false,
      offline: true,
      online: false,
      originalAvailable: true,
      accountOwned: false,
      thumbnailUrl: null,
      starred: false,
      removed: false,
      playCount: 1,
      updatedAt: 1,
      canRename: false,
      canDeleteAccount: false,
      canExport: true,
    },
  ],
};
const report = diagnosticReport({
  events: [],
  identity: diagnosticIdentity,
  now: 1700000000000,
  availability: "no-logs",
  failureCode: null,
  malformed: 0,
  recovered: 0,
  rejected: 0,
  failedWrites: 0,
  retained: 0,
  maximum: 1048576,
  incomplete: false,
});
const cases = [
  {
    kind: "account-delete",
    open: "Request account deletion",
    dialog: "Confirm account action",
    safe: "Keep account unchanged",
  },
  {
    kind: "account-all",
    open: "Sign out everywhere",
    dialog: "Confirm account action",
    safe: "Keep account unchanged",
  },
  {
    kind: "account-unlink",
    open: "Unlink password",
    dialog: "Confirm account action",
    safe: "Keep account unchanged",
  },
  {
    kind: "library-delete",
    open: "Delete local result",
    dialog: "Confirm audio deletion",
    safe: "Keep audio",
  },
  {
    kind: "library-history",
    open: "Clear listening history",
    dialog: "Confirm history clear",
    safe: "Keep history",
  },
  {
    kind: "preferences",
    open: "Reset preferences",
    dialog: "Confirm preferences reset",
    safe: "Keep preferences",
  },
  {
    kind: "storage",
    open: "Clear saved voices",
    dialog: "Confirm cache cleanup",
    safe: "Keep files",
  },
  {
    kind: "outbox",
    open: "Discard pending save",
    dialog: "Confirm pending save discard",
    safe: "Keep pending save",
  },
  {
    kind: "diagnostics",
    open: "Clear local diagnostics",
    dialog: "Confirm local diagnostics clear",
    safe: "Keep local diagnostics",
  },
  {
    kind: "update",
    open: "Install update",
    dialog: "Confirm MusicMute update",
    safe: "Cancel",
  },
  {
    kind: "worker",
    open: "Revoke this worker",
    dialog: "Confirm worker action",
    safe: "Keep current state",
  },
] as const;
type Kind = (typeof cases)[number]["kind"];
const noop = async () => {};
function AuditSurface({
  kind,
  busy,
  observed,
}: {
  kind: Kind;
  busy: boolean;
  observed: (value: unknown) => Promise<void>;
}) {
  const [worker, setWorker] = useState<FleetAdvancedView>({
    phase: "idle",
    machineId,
    section: "status",
    data: null,
    confirmation: null,
    problem: null,
    cancellable: false,
  });
  let panel;
  if (kind.startsWith("account")) {
    const view = accountView();
    panel = (
      <AccountPanel
        view={{
          ...view,
          destructiveReview: {
            accountId: view.user!.id,
            generation: "00000000-0000-4000-8000-000000000001",
          },
          user: { ...view.user!, providers: ["password", "google.com"] },
        }}
        blocked={busy}
        execute={observed}
      />
    );
  } else if (kind.startsWith("library"))
    panel = (
      <LibraryPanel
        view={library}
        history={{ state: "ready", errorCode: null, entries: [] }}
        busy={busy}
        execute={observed}
        play={() => {}}
        queue={() => {}}
        download={noop}
        exportTrack={noop}
        nextPage={noop}
        historyCommand={observed}
      />
    );
  else if (kind === "preferences")
    panel = (
      <PreferencesPanel
        view={{
          state: "ready",
          value: DEFAULT_PREFERENCES,
          resolvedLanguage: "en",
          errorCode: null,
        }}
        busy={busy}
        execute={observed}
      />
    );
  else if (kind === "storage")
    panel = <StoragePanel view={storage} busy={busy} execute={observed} />;
  else if (kind === "outbox")
    panel = (
      <OutboxPanel
        view={{
          authenticated: true,
          busy: false,
          errorCode: null,
          items: [
            {
              requestId,
              localId: "local:one",
              kind: "pair",
              state: "pending",
              title: "Mixed عربي retained audio",
              errorCode: null,
              jobId: null,
              nextAttemptAt: null,
            },
          ],
        }}
        busy={busy}
        execute={observed}
      />
    );
  else if (kind === "diagnostics")
    panel = (
      <DiagnosticsPanel
        view={{
          busy: false,
          problem: null,
          report,
          doctor: null,
          exportReceipt: null,
        }}
        busy={busy}
        execute={observed}
        clear={() => observed("clear")}
        exportReport={noop}
      />
    );
  else if (kind === "update")
    panel = (
      <ConsumerUpdatePanel view={update} busy={busy} execute={observed} />
    );
  else {
    const execute = async (command: FleetAdvancedUiCommand) => {
      if (command.type === "CONFIRM")
        setWorker({
          ...worker,
          phase: "confirmation",
          confirmation: {
            token,
            action: command.mutation.action,
            expiresAt: "2099-01-01T00:00:00Z",
          },
        });
      await observed(command);
    };
    panel = (
      <WorkerAdvancedPanel
        machineId={machineId}
        view={worker}
        busy={busy}
        execute={execute}
        exportReport={noop}
        selectInput={noop}
      />
    );
  }
  return (
    <main>
      <h1 tabIndex={-1}>Audit route</h1>
      {panel}
    </main>
  );
}
function named(container: HTMLElement) {
  const roles = getRoles(container);
  for (const role of [
    "button",
    "textbox",
    "checkbox",
    "combobox",
    "slider",
    "spinbutton",
    "dialog",
  ])
    for (const element of roles[role] ?? []) {
      if (element === container) continue; // Query APIs search descendants; the modal itself is named separately.
      expect(
        queryAllByRole(container, role, { name: /\S/u }),
        element.outerHTML,
      ).toContain(element);
    }
}
for (const language of ["en", "ar"] as const)
  for (const entry of cases)
    it(`keeps ${entry.kind} modal named, safely focused, trapped, busy-blocked and reversible in ${language}`, async () => {
      setLanguage(language);
      const observed = vi.fn(async (_value: unknown) => {}),
        rendered = render(
          <AuditSurface kind={entry.kind} busy={false} observed={observed} />,
        );
      // Native details disclosure is represented by its real DOM open state in this headless audit.
      for (const detail of rendered.container.querySelectorAll("details"))
        detail.open = true;
      const invoker = screen.getByRole("button", { name: t(entry.open) });
      invoker.focus();
      fireEvent.click(invoker);
      await act(async () => {});
      const dialog = screen.getByRole("dialog", { name: t(entry.dialog) }),
        safe = within(dialog).getByRole("button", { name: t(entry.safe) }),
        count = observed.mock.calls.length;
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(document.activeElement).toBe(safe);
      named(dialog);
      const buttons = within(dialog).getAllByRole("button"),
        first = buttons[0]!,
        last = buttons.at(-1)!;
      first.focus();
      fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);
      fireEvent.keyDown(last, { key: "Tab" });
      expect(document.activeElement).toBe(first);
      rendered.rerender(
        <AuditSurface kind={entry.kind} busy observed={observed} />,
      );
      expect(
        (
          within(dialog).getByRole("button", {
            name: t(entry.safe),
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(document.activeElement).toBe(dialog);
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(observed.mock.calls).toHaveLength(count);
      rendered.rerender(
        <AuditSurface kind={entry.kind} busy={false} observed={observed} />,
      );
      fireEvent.keyDown(dialog, { key: "Escape" });
      await act(async () => {});
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(invoker);
      // Worker dismissal invalidates its one-use token; the other dialogs issue no side effect.
      expect(observed.mock.calls.length).toBe(
        count + (entry.kind === "worker" ? 1 : 0),
      );
    });
function RemovedInvoker({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false),
    [done, setDone] = useState(false);
  return (
    <main>
      <h1 tabIndex={-1}>Retained route</h1>
      {(!done || disabled) && (
        <button disabled={disabled && done} onClick={() => setOpen(true)}>
          Open destructive review
        </button>
      )}
      {open && (
        <ModalDialog label="Destructive review" onClose={() => setOpen(false)}>
          <button
            onClick={() => {
              setDone(true);
              setOpen(false);
            }}
          >
            Confirm
          </button>
          <button data-dialog-initial-focus onClick={() => setOpen(false)}>
            Keep
          </button>
        </ModalDialog>
      )}
    </main>
  );
}
it.each([false, true])(
  "restores a logical route target when the invoker is removed or disabled (%s)",
  (disabled) => {
    render(<RemovedInvoker disabled={disabled} />);
    const start = screen.getByRole("button", {
      name: "Open destructive review",
    });
    start.focus();
    fireEvent.click(start);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Keep" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Retained route" }),
    );
  },
);
it("keeps native identities and report controls under collapsed Worker Advanced by default", () => {
  const { container } = render(
    <WorkerPanel
      view={{
        state: "registered",
        eligibility: "signed-out",
        busy: false,
        machineId,
        label: "Simple worker",
        intent: "stopped",
        connected: false,
        backendState: null,
        activeAttempts: null,
        claimsAllowed: false,
        errorCode: null,
      }}
      busy={false}
      execute={noop}
      signIn={() => {}}
      advanced={{
        phase: "idle",
        machineId,
        section: "status",
        data: { gpuLuid: "sensitive-local-gpu-id" },
        confirmation: null,
        problem: null,
        cancellable: false,
      }}
      executeAdvanced={noop}
      exportReport={noop}
      selectInput={noop}
    />,
  );
  const details = container.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(
    screen.getByRole("button", { name: "Read report" }).closest("details"),
  ).toBe(details);
  expect(screen.getByText("sensitive-local-gpu-id").closest("details")).toBe(
    details,
  );
});
for (const language of ["en", "ar"] as const)
  it(`gives populated queue controls meaningful localized names and exact occurrence authority in ${language}`, () => {
    setLanguage(language);
    const execute = vi.fn(async () => {}),
      snapshot: PlaybackView = {
        generation: randomUUID(),
        trackId: "one",
        phase: "paused",
        variant: "voice",
        position: 0,
        sourcePosition: 0,
        duration: 60,
        url: null,
        requestedPlaying: false,
        seekRevision: 0,
        rate: 1,
        volume: 0.8,
        muted: false,
        repeat: "off",
        shuffle: false,
        queue: ["one", "two", "one"],
        queueRevision: 5,
        error: null,
      };
    const { container } = render(
      <PlayerPanel
        view={snapshot}
        defaultExpanded
        tracks={[
          { id: "one", title: "Mixed عربي title" },
          { id: "two", title: "Second" },
        ]}
        execute={execute}
      />,
    );
    named(container);
    const removals = screen.getAllByRole("button", {
      name: t("Remove {name} from queue", { name: "Mixed عربي title" }),
    });
    fireEvent.click(removals[1]!);
    expect(execute).toHaveBeenCalledWith({
      type: "QUEUE_EDIT",
      action: "remove",
      trackId: "one",
      index: 2,
      generation: snapshot.generation,
      queueRevision: 5,
    });
  });
