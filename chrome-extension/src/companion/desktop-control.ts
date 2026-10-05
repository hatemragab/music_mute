import { loadLocalConfig } from "./config.js";
import {
  parseDesktopRequest,
  type DesktopEvent,
} from "../shared/desktop-protocol.js";
import { executeDesktopRequest, safeDesktopCode } from "./desktop-service.js";
import { NativeAccountState } from "./account-state.js";
import { startCommunityPublisher } from "./community-publisher.js";
import { YouTubeCommunityOutbox } from "./youtube-community-outbox.js";
import { join } from "node:path";

process.umask(0o077);
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
let requestId = "";
let terminal = false;
function emit(event: DesktopEvent): void {
  if (terminal) return;
  const line = JSON.stringify(event) + "\n";
  if (Buffer.byteLength(line) > 65536 || process.stdout.writableLength > 262144)
    throw new Error("DESKTOP_REPLY_TOO_LARGE");
  if (event.type !== "progress") terminal = true;
  process.stdout.write(line);
}
/** Closing stdin after the one request is normal. Native cancellation uses SIGTERM. */
async function readRequest(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 65536) throw new Error("INVALID_DESKTOP_REQUEST");
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trimEnd();
  if (value.includes("\n")) throw new Error("INVALID_DESKTOP_REQUEST");
  return value;
}
let state: NativeAccountState | undefined;
try {
  const request = parseDesktopRequest(await readRequest());
  requestId = request.request_id;
  const config = await loadLocalConfig();
  // Guest publication recovery is independent of a signed-in account or an open Chrome tab.
  void new YouTubeCommunityOutbox(join(config.root, "youtube-community-outbox"))
    .records()
    .then((records) => {
      if (records.some((record) => record.state === "pending"))
        return startCommunityPublisher(config);
    })
    .catch(() => {});
  state = new NativeAccountState(config.root);
  await state.start(() => controller.abort());
  const result = await executeDesktopRequest(
    config,
    request,
    emit,
    controller.signal,
    {
      isCurrent: (owner) => state!.matches(owner),
      verifyCurrent: (owner) => state!.isCurrent(owner),
    },
  );
  emit({
    protocol_version: 1,
    request_id: requestId,
    type: "result",
    payload: result,
  });
} catch (error) {
  emit({
    protocol_version: 1,
    request_id: requestId,
    type: "error",
    error_code: safeDesktopCode(error),
  });
  // Protocol errors have a terminal JSON frame; nonzero is reserved for a crashed helper.
} finally {
  state?.close();
}
