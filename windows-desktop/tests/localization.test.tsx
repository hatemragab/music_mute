// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import ts from "typescript";
import { setLanguage, t, trackCount } from "../src/renderer/i18n.js";
import { ARABIC } from "../src/renderer/locales.js";
import { DesktopApp } from "../src/renderer/app.js";
import { DEFAULT_PREFERENCES } from "../src/shared/preferences-contracts.js";
import type {
  DesktopBridge,
  DesktopSnapshot,
} from "../src/shared/contracts.js";
import { shortcut } from "../src/renderer/shortcuts.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";
afterEach(() => {
  cleanup();
  setLanguage("en");
  document.documentElement.dir = "ltr";
});
it("covers renderer translation keys and preserves dynamic placeholders", async () => {
  const directory = resolve(process.cwd(), "src/renderer");
  for (const file of (await readdir(directory)).filter((name) =>
    name.endsWith(".tsx"),
  )) {
    const source = await readFile(join(directory, file), "utf8"),
      tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        expect(
          ARABIC[node.arguments[0].text],
          `${file}: ${node.arguments[0].text}`,
        ).toBeTruthy();
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        [
          "labels",
          "stages",
          "errors",
          "phases",
          "status",
          "checks",
          "messages",
          "categoryLabels",
        ].includes(node.name.text) &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const property of node.initializer.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isStringLiteral(property.initializer)
          )
            expect(
              ARABIC[property.initializer.text],
              `${file}: ${node.name.text}: ${property.initializer.text}`,
            ).toBeTruthy();
        }
      }
      if (ts.isJsxText(node))
        expect(
          /[A-Za-z]/.test(node.text.trim()),
          `${file}: untranslated JSX ${node.text.trim()}`,
        ).toBe(false);
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  for (const [key, value] of Object.entries(ARABIC)) {
    expect(value.trim()).not.toBe("");
    expect(
      [...key.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort(),
      key,
    ).toEqual(
      [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
        .map((match) => match[1])
        .sort(),
    );
  }
  setLanguage("ar");
  expect(t("Selected: {name}", { name: "<source.wav>" })).toContain(
    "<source.wav>",
  );
  expect(trackCount(2)).toBe("مساران");
  expect(t("unknown future key")).toBe("unknown future key");
});
it("switches the complete app navigation and document direction from a saved Arabic preference", async () => {
  let snapshot: DesktopSnapshot = {
    protocolVersion: 1,
    sequence: 1,
    section: "settings",
    setup: {
      state: "missing",
      message: "Prepare this PC for local processing.",
    },
    account: { state: "signed-out", displayName: null },
    worker: { state: "not-enrolled" },
    preferences: {
      state: "ready",
      errorCode: null,
      value: { ...DEFAULT_PREFERENCES, language: "ar" },
      resolvedLanguage: "ar",
    },
  };
  let notify: ((value: DesktopSnapshot) => void) | undefined;
  const reply = async () => ({ ok: true as const, snapshot });
  const bridge: DesktopBridge = {
    diagnostics: reply,
    diagnosticsExport: reply,
    diagnosticsClear: reply,
    fleetBenchmarkPick: reply,
    fleetBenchmarkClear: reply,
    consumerUpdate: reply,
    getSnapshot: reply,
    navigate: reply,
    openProduct: reply,
    selectInput: reply,
    dropInput: reply,
    quitPersonal: reply,
    account: reply,
    prepare: reply,
    setupAssistance: reply,
    personal: reply,
    playback: reply,
    cloud: reply,
    library: reply,
    libraryDownload: reply,
    libraryExport: reply,
    libraryShare: reply,
    fleetAdvanced: reply,
    fleetAdvancedExport: reply,
    libraryNextPage: reply,
    libraryPlay: reply,
    history: reply,
    preferences: reply,
    storage: reply,
    outbox: reply,
    fleet: reply,
    librarySaveToAccount: reply,
    reviewCloudHandoff: reply,
    clearCloudHandoff: reply,
    onSnapshot: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  };
  window.musicmute = bridge;
  render(<DesktopApp />);
  await screen.findByRole("heading", { name: "التفضيلات" });
  await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
  expect(screen.getByRole("button", { name: "الرئيسية" })).toBeTruthy();
  await act(async () => {
    snapshot = {
      ...snapshot,
      sequence: 2,
      preferences: {
        ...snapshot.preferences!,
        resolvedLanguage: "en",
        value: { ...DEFAULT_PREFERENCES, language: "en" },
      },
    };
    notify?.(snapshot);
  });
  await screen.findByRole("heading", { name: "Preferences" });
  expect(document.documentElement.dir).toBe("ltr");
});
it("protects typing and button activation from playback shortcuts and clamps text size", () => {
  const event = {
    key: " ",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
  };
  expect(shortcut(event, true, false)).toBeNull();
  expect(shortcut(event, false, true)).toBeNull();
  expect(shortcut(event, false, false)).toEqual({ action: "toggle" });
  expect(shortcut({ ...event, key: "1", ctrlKey: true }, false, false)).toEqual(
    { action: "navigate", section: "home" },
  );
  expect(
    shortcut(
      { ...event, key: "+", ctrlKey: true },
      false,
      false,
      "accessibility",
    ),
  ).toEqual({ action: "text", size: "accessibility" });
  expect(shortcut({ ...event, repeat: true }, false, false)).toBeNull();
  expect(vi.isMockFunction(window.musicmute)).toBe(false);
});
it.each([
  [0, "لا مسارات"],
  [1, "مسار واحد"],
  [2, "مساران"],
  [3, `${new Intl.NumberFormat("ar").format(3)} مسارات`],
  [11, `${new Intl.NumberFormat("ar").format(11)} مسارًا`],
  [100, `${new Intl.NumberFormat("ar").format(100)} مسار`],
])("uses the Arabic plural category for %i tracks", (count, expected) => {
  setLanguage("ar");
  expect(trackCount(count as number)).toBe(expected);
});
it("keeps an open confirmation and its focus while language and theme change", async () => {
  const f = desktopUiFixture({
    section: "settings",
    preferences: {
      state: "ready",
      errorCode: null,
      value: { ...DEFAULT_PREFERENCES, language: "en" },
      resolvedLanguage: "en",
    },
  });
  f.bridge.preferences = vi.fn(async () => ({
    ok: true as const,
    snapshot: f.snapshot(),
  }));
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  const initiator = await screen.findByRole("button", {
    name: "Reset preferences",
  });
  initiator.focus();
  fireEvent.click(initiator);
  const confirm = screen.getByRole("button", { name: "Confirm reset" });
  const keep = screen.getByRole("button", { name: "Keep preferences" });
  expect(document.activeElement).toBe(keep);
  await act(async () =>
    f.publish({
      preferences: {
        ...f.snapshot().preferences!,
        value: {
          ...f.snapshot().preferences!.value,
          language: "ar",
          appearance: "light",
        },
        resolvedLanguage: "ar",
      },
    }),
  );
  expect(
    await screen.findByRole("dialog", { name: "تأكيد إعادة تعيين التفضيلات" }),
  ).toBeTruthy();
  expect(document.activeElement).toBe(keep);
  expect(confirm.textContent).toBe("تأكيد إعادة التعيين");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.dir).toBe("rtl");
  expect(f.bridge.preferences).not.toHaveBeenCalled();
  fireEvent.keyDown(keep, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(initiator);
});
it("retranslates a visible action error and readiness message when language/theme change without replacing the selected file", async () => {
  const f = desktopUiFixture(
    {
      selectedInput: {
        capability: "00000000-0000-4000-8000-000000000000",
        name: "sample.wav",
        bytes: 12,
      },
      preferences: {
        state: "ready",
        errorCode: null,
        value: { ...DEFAULT_PREFERENCES, language: "en" },
        resolvedLanguage: "en",
      },
    },
    { selectInput: async () => ({ ok: false, errorCode: "OPERATION_FAILED" }) },
  );
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose audio or video" }),
  );
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toBe(
    "MusicMute could not complete this action. Try again.",
  );
  await act(async () => {
    f.publish({
      preferences: {
        ...f.snapshot().preferences!,
        value: { ...DEFAULT_PREFERENCES, language: "ar", appearance: "light" },
        resolvedLanguage: "ar",
      },
    });
  });
  expect(screen.getByRole("alert").textContent).toBe(
    ARABIC["MusicMute could not complete this action. Try again."],
  );
  expect(
    screen.getByText(ARABIC["Prepare this PC for local processing."]!),
  ).toBeTruthy();
  expect(screen.getByText(/sample.wav/)).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe("light");
});
