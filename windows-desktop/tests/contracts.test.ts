import { expect, it } from "vitest";
import { parseDesktopCommand } from "../src/shared/contracts.js";
it("allows only explicit renderer commands", () => {
  expect(
    parseDesktopCommand({
      type: "SETUP_ASSISTANCE",
      command: { type: "REVEAL_EXTENSION" },
    }),
  ).toEqual({
    type: "SETUP_ASSISTANCE",
    command: { type: "REVEAL_EXTENSION" },
  });
  expect(
    parseDesktopCommand({
      type: "CONSUMER_UPDATE",
      command: {
        version: 1,
        request_id: "00000000-0000-4000-8000-000000000000",
        action: "check",
      },
    }),
  ).toMatchObject({ type: "CONSUMER_UPDATE" });
  expect(parseDesktopCommand({ type: "NAVIGATE", section: "library" })).toEqual(
    { type: "NAVIGATE", section: "library" },
  );
  expect(parseDesktopCommand({ type: "GET_SNAPSHOT" })).toEqual({
    type: "GET_SNAPSHOT",
  });
});
it.each([
  null,
  {
    type: "SETUP_ASSISTANCE",
    command: { type: "OPEN_URL", url: "chrome://extensions" },
  },
  {
    type: "SETUP_ASSISTANCE",
    command: { type: "REVEAL_EXTENSION", path: "C:\\private" },
  },
  {
    type: "SETUP_ASSISTANCE",
    command: { type: "REVEAL_MODEL" },
    path: "C:\\private",
  },
  {
    type: "DIAGNOSTICS",
    command: {
      type: "EXPORT",
      destinationCapability: "00000000-0000-4000-8000-000000000000",
    },
  },
  { type: "DIAGNOSTICS", command: { type: "CLEAR" } },
  { type: "DIAGNOSTICS_EXPORT", path: "C:\\elsewhere.json" },
  { type: "DIAGNOSTICS_CLEAR", confirmation: "yes" },
  {
    type: "LIBRARY_SHARE",
    trackId: "local:one",
    variant: "voice",
    path: "C:\\private.mp3",
  },
  {
    type: "LIBRARY_SHARE",
    trackId: "local:one",
    variant: "voice",
    windowHandle: "1",
  },
  { type: "LIBRARY_SHARE", trackId: "local:one", variant: "video" },
  { type: "FLEET_BENCHMARK_PICK", kind: "audio", path: "C:\\evil.zip" },
  { type: "FLEET_BENCHMARK_PICK", kind: "shell" },
  { type: "FLEET_BENCHMARK_CLEAR", owner: "other-window" },
  {
    type: "CONSUMER_UPDATE",
    command: {
      version: 1,
      request_id: "00000000-0000-4000-8000-000000000000",
      action: "install",
      path: "C:\\evil.exe",
    },
  },
  {
    type: "CONSUMER_UPDATE",
    command: {
      version: 1,
      request_id: "00000000-0000-4000-8000-000000000000",
      action: "check",
    },
    bearer: "secret",
  },
  [],
  { type: "EXEC", command: "calc" },
  { type: "NAVIGATE", section: "root" },
  { type: "GET_SNAPSHOT", id_token: "secret" },
  { type: "DROP_INPUT", path: "file\u0000.mp3" },
  { type: "DROP_INPUT", path: "" },
  { type: "SELECT_INPUT", path: "C:\\secret.mp3" },
  { type: "QUIT_PERSONAL", confirmed: true },
  { type: "FLEET", command: { type: "REVOKE", confirmed: true } },
  {
    type: "FLEET_ADVANCED",
    command: {
      type: "EXPORT",
      destinationCapability: "00000000-0000-4000-8000-000000000000",
    },
  },
  { type: "FLEET_ADVANCED_EXPORT", path: "C:\\private.zip" },
  {
    type: "ACCOUNT",
    command: {
      type: "SIGN_IN_EMAIL",
      email: "fixture@example.test",
      password: "fixture",
      id_token: "forged",
    },
  },
  {
    type: "ACCOUNT",
    command: { type: "DELETE_ACCOUNT", password: "fixture", confirmed: false },
  },
  { type: "OPEN_PRODUCT", destination: "https://evil.example" },
  {
    type: "LIBRARY_DOWNLOAD",
    trackId: "job",
    variant: "voice",
    path: "C:\\secret.mp3",
  },
  { type: "LIBRARY_EXPORT", trackId: "../../outside", variant: "voice" },
  { type: "LIBRARY_NEXT_PAGE", cursor: "renderer-cursor" },
  {
    type: "CLOUD",
    command: {
      type: "PREPARE_FILE",
      fileCapability: "forged",
      name: "x.mp3",
      bytes: 1,
    },
  },
  { type: "HISTORY", command: { type: "CLEAR", owner: "other-user" } },
])("rejects untrusted command %j", (value) =>
  expect(() => parseDesktopCommand(value)).toThrow(),
);
it.each(["PREPARE", "FLEET_BENCHMARK_PICK"] as const)(
  "refuses hostile %s enums without invoking their conversion",
  (type) => {
    let converted = false;
    const value = {
      toString() {
        converted = true;
        return type === "PREPARE" ? "repair" : "audio";
      },
    };
    expect(() =>
      parseDesktopCommand(
        type === "PREPARE" ? { type, action: value } : { type, kind: value },
      ),
    ).toThrow();
    expect(converted).toBe(false);
  },
);
