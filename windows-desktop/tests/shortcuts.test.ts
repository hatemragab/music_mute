import { expect, it } from "vitest";
import {
  FIXED_SHORTCUTS,
  TEXT_SHORTCUTS,
  shortcut,
} from "../src/renderer/shortcuts.js";
import { ARABIC } from "../src/renderer/locales.js";
it.each(FIXED_SHORTCUTS)(
  "dispatches and documents $chord from the same catalog",
  (definition) => {
    const event = {
      key: definition.key,
      ctrlKey: !!definition.ctrl,
      altKey: !!definition.alt,
      shiftKey: !!definition.shift,
      metaKey: false,
      repeat: false,
    };
    expect(shortcut(event, false, false)).toEqual(definition.command);
    expect(shortcut(event, true, false)).toBeNull();
    expect(shortcut({ ...event, repeat: true }, false, false)).toBeNull();
    expect(shortcut({ ...event, metaKey: true }, false, false)).toBeNull();
    expect(ARABIC[definition.label]).toBeTruthy();
  },
);
it("resets only text size to System, clamps the size cycle and preserves focused Space activation", () => {
  const event = {
    key: "0",
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
  };
  expect(shortcut(event, false, false, "accessibility")).toEqual({
    action: "text",
    size: "system",
  });
  expect(
    shortcut(
      { ...event, key: "+", shiftKey: true },
      false,
      false,
      "accessibility",
    ),
  ).toEqual({ action: "text", size: "accessibility" });
  expect(
    shortcut({ ...event, key: " ", ctrlKey: false }, false, true),
  ).toBeNull();
  for (const row of TEXT_SHORTCUTS) expect(ARABIC[row.label]).toBeTruthy();
});
