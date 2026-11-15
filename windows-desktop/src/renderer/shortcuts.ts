import {
  TEXT_SCALES,
  type DesktopPreferences,
} from "../shared/preferences-contracts.js";
import type { Section } from "../shared/contracts.js";
export type Shortcut =
  | { action: "navigate"; section: Section }
  | {
      action:
        | "choose"
        | "toggle"
        | "mute"
        | "next"
        | "source"
        | "star"
        | "stop"
        | "readiness";
    }
  | { action: "seek"; delta: number }
  | { action: "volume"; delta: number }
  | { action: "text"; size: DesktopPreferences["textSize"] };
interface ShortcutDefinition {
  label: string;
  chord: string;
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  command: Shortcut;
}
export const FIXED_SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    label: "Home",
    chord: "Ctrl+1",
    key: "1",
    ctrl: true,
    command: { action: "navigate", section: "home" },
  },
  {
    label: "Library",
    chord: "Ctrl+2",
    key: "2",
    ctrl: true,
    command: { action: "navigate", section: "library" },
  },
  {
    label: "Account",
    chord: "Ctrl+3",
    key: "3",
    ctrl: true,
    command: { action: "navigate", section: "account" },
  },
  {
    label: "Prepare",
    chord: "Ctrl+4",
    key: "4",
    ctrl: true,
    command: { action: "navigate", section: "setup" },
  },
  {
    label: "Diagnostics",
    chord: "Ctrl+5",
    key: "5",
    ctrl: true,
    command: { action: "navigate", section: "diagnostics" },
  },
  {
    label: "Choose audio or video",
    chord: "Ctrl+N",
    key: "n",
    ctrl: true,
    command: { action: "choose" },
  },
  {
    label: "Play or pause",
    chord: "Ctrl+Shift+P",
    key: "p",
    ctrl: true,
    shift: true,
    command: { action: "toggle" },
  },
  {
    label: "Switch voice and original",
    chord: "Ctrl+Shift+V",
    key: "v",
    ctrl: true,
    shift: true,
    command: { action: "source" },
  },
  {
    label: "Star current audio",
    chord: "Ctrl+Shift+F",
    key: "f",
    ctrl: true,
    shift: true,
    command: { action: "star" },
  },
  {
    label: "Mute or unmute",
    chord: "Ctrl+Shift+M",
    key: "m",
    ctrl: true,
    shift: true,
    command: { action: "mute" },
  },
  {
    label: "Next audio",
    chord: "Ctrl+Alt+Right",
    key: "arrowright",
    ctrl: true,
    alt: true,
    command: { action: "next" },
  },
  {
    label: "Increase volume",
    chord: "Ctrl+Alt+Up",
    key: "arrowup",
    ctrl: true,
    alt: true,
    command: { action: "volume", delta: 0.05 },
  },
  {
    label: "Decrease volume",
    chord: "Ctrl+Alt+Down",
    key: "arrowdown",
    ctrl: true,
    alt: true,
    command: { action: "volume", delta: -0.05 },
  },
  {
    label: "Stop playback",
    chord: "Ctrl+.",
    key: ".",
    ctrl: true,
    command: { action: "stop" },
  },
  {
    label: "Check PC readiness",
    chord: "Ctrl+Shift+R",
    key: "r",
    ctrl: true,
    shift: true,
    command: { action: "readiness" },
  },
  {
    label: "Play or pause",
    chord: "Space",
    key: " ",
    command: { action: "toggle" },
  },
  {
    label: "Mute or unmute",
    chord: "M",
    key: "m",
    command: { action: "mute" },
  },
  {
    label: "Back 10 seconds",
    chord: "Left",
    key: "arrowleft",
    command: { action: "seek", delta: -10 },
  },
  {
    label: "Forward 10 seconds",
    chord: "Right",
    key: "arrowright",
    command: { action: "seek", delta: 10 },
  },
];
export const TEXT_SHORTCUTS = [
  { label: "Make text larger", chord: "Ctrl+Plus" },
  { label: "Make text smaller", chord: "Ctrl+Minus" },
  { label: "Reset text size to System", chord: "Ctrl+0" },
];
/** Renderer-only shortcuts; editable fields and native button activation retain their usual behavior. */
export function shortcut(
  event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
  },
  editable: boolean,
  button: boolean,
  textSize: DesktopPreferences["textSize"] = "system",
): Shortcut | null {
  if (editable || event.repeat || event.metaKey) return null;
  const key = event.key.toLowerCase();
  const fixed = FIXED_SHORTCUTS.find(
    (row) =>
      row.key === key &&
      !!row.ctrl === event.ctrlKey &&
      !!row.alt === event.altKey &&
      !!row.shift === event.shiftKey,
  );
  if (fixed) return key === " " && button ? null : { ...fixed.command };
  if (event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (key === "0") return { action: "text", size: "system" };
    if (["=", "+", "-"].includes(key)) {
      const sizes = Object.keys(TEXT_SCALES).filter(
          (size) => size !== "system",
        ) as DesktopPreferences["textSize"][],
        at = sizes.indexOf(textSize === "system" ? "standard" : textSize);
      return {
        action: "text",
        size: sizes[
          Math.max(0, Math.min(sizes.length - 1, at + (key === "-" ? -1 : 1)))
        ]!,
      };
    }
  }
  if (event.ctrlKey && event.shiftKey && !event.altKey) {
    if (key === "+" || key === "=")
      return shortcut(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: false,
          metaKey: event.metaKey,
          repeat: event.repeat,
        },
        false,
        button,
        textSize,
      );
  }
  return null;
}
