export type SetupAssistanceCommand = {
  type:
    | "OPEN_CHROME_EXTENSIONS"
    | "REVEAL_EXTENSION"
    | "COPY_EXTENSION_PATH"
    | "REVEAL_MODEL";
};
export interface SetupAssistanceView {
  state: "checking" | "ready" | "error";
  busy: boolean;
  extension: "available" | "unavailable";
  chrome: "available" | "unavailable";
  modelFolder: "available" | "unavailable";
  problem: "SETUP_ASSISTANCE_UNAVAILABLE" | null;
}
export function parseSetupAssistanceCommand(
  value: unknown,
): SetupAssistanceCommand {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "type" ||
    typeof (value as { type?: unknown }).type !== "string" ||
    ![
      "OPEN_CHROME_EXTENSIONS",
      "REVEAL_EXTENSION",
      "COPY_EXTENSION_PATH",
      "REVEAL_MODEL",
    ].includes((value as { type: string }).type)
  )
    throw new Error("INVALID_COMMAND");
  return { type: (value as SetupAssistanceCommand).type };
}
