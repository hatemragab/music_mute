import type { HelloPayload, ProviderId } from "./protocol.js";
/** Browser-safe host selection; shared MM_START remains a local intent. */
export function isLocalProvider(
  value: unknown,
): value is "LOCAL_MACOS" | "LOCAL_WINDOWS" {
  return value === "LOCAL_MACOS" || value === "LOCAL_WINDOWS";
}
export function localProviderForHello(
  hello: Pick<HelloPayload, "platform" | "arch"> | null | undefined,
): Extract<ProviderId, "LOCAL_MACOS" | "LOCAL_WINDOWS"> | undefined {
  if (hello?.platform === "win32" && hello.arch === "x64")
    return "LOCAL_WINDOWS";
  if (hello?.platform === "darwin" && hello.arch === "arm64")
    return "LOCAL_MACOS";
  return undefined;
}
