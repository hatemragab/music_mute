#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import workerPackage from "../../package.json" with { type: "json" };
import { createMacAppCommandContext } from "../platform/macos/app-installation.js";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  executeAppControlCommand,
  subscribeAppControl,
  type AppControlDependencies,
} from "../platform/macos/app-control.js";
import {
  APP_CONTROL_REQUEST_LIMIT,
  APP_CONTROL_RESPONSE_LIMIT,
  AppControlError,
  isRecord,
  parseAppControlRequest,
  type AppControlResponse,
} from "../platform/macos/app-control-protocol.js";

/** A single private request stream; never shell-evaluates input or echoes failures. */
export async function runAppControlSession(
  input: Readable,
  output: Writable,
  dependencies: AppControlDependencies = {},
): Promise<void> {
  const subscription = new AbortController();
  const stop = () => subscription.abort();
  let requestId = "00000000-0000-4000-8000-000000000000";
  let outputFailed = false;
  let invalidExtraInput = false;
  const send = (response: AppControlResponse) => {
    if (outputFailed || output.destroyed) return;
    if (invalidExtraInput && response.type !== "ERROR") return;
    const line = `${JSON.stringify(response)}\n`;
    if (
      Buffer.byteLength(line, "utf8") > APP_CONTROL_RESPONSE_LIMIT ||
      output.writableLength + Buffer.byteLength(line, "utf8") >
        APP_CONTROL_RESPONSE_LIMIT
    ) {
      outputFailed = true;
      subscription.abort();
      return;
    }
    output.write(line);
  };
  const onExtraInput = (chunk: Buffer | string) => {
    if (invalidExtraInput || !chunk.toString().trim()) return;
    invalidExtraInput = true;
    send({
      protocol_version: 1,
      request_id: requestId,
      type: "ERROR",
      error_code: "INVALID_REQUEST",
    });
    subscription.abort();
  };
  input.once("end", stop);
  input.once("error", stop);
  output.once("error", () => {
    outputFailed = true;
    stop();
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const value = await readAppControlFrame(input);
    if (
      isRecord(value) &&
      typeof value.request_id === "string" &&
      /^[0-9a-f-]{36}$/iu.test(value.request_id)
    )
      requestId = value.request_id;
    const request = parseAppControlRequest(value);
    input.on("data", onExtraInput);
    input.resume();
    if (request.type === "SUBSCRIBE") {
      await subscribeAppControl(
        request,
        send,
        subscription.signal,
        dependencies,
      );
    } else await executeAppControlCommand(request, send, dependencies);
  } catch (error) {
    send({
      protocol_version: 1,
      request_id: requestId,
      type: "ERROR",
      error_code:
        error instanceof AppControlError ? error.errorCode : "INVALID_REQUEST",
    });
  } finally {
    input.removeListener("end", stop);
    input.removeListener("error", stop);
    input.removeListener("data", onExtraInput);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function readAppControlFrame(input: Readable): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const fail = (code: "INVALID_REQUEST" | "FRAME_TOO_LARGE") => {
      cleanup();
      reject(new AppControlError(code));
    };
    const onEnd = () => fail("INVALID_REQUEST");
    const onError = () => fail("INVALID_REQUEST");
    const onData = (chunk: Buffer | string) => {
      bytes = Buffer.concat([
        bytes,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
      ]);
      if (bytes.length > APP_CONTROL_REQUEST_LIMIT) {
        fail("FRAME_TOO_LARGE");
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      if (
        bytes
          .subarray(end + 1)
          .toString("utf8")
          .trim()
      ) {
        fail("INVALID_REQUEST");
        return;
      }
      cleanup();
      input.pause();
      try {
        // Fatal decoding rejects replacement characters and partial UTF-8 sequences.
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, end),
        );
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new AppControlError("INVALID_REQUEST"));
      }
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  // JSON import embeds the package version in the standalone app bundle.
  const resources = process.env.MUSICMUTE_LOCAL_APP_RESOURCES;
  const support =
    process.env.MUSICMUTE_LOCAL_ROOT ??
    join(homedir(), "Library", "Application Support", "MusicMuteLocal");
  await runAppControlSession(process.stdin, process.stdout, {
    packageVersion: workerPackage.version,
    ...(resources === undefined
      ? {}
      : { context: createMacAppCommandContext(resources, support) }),
  });
}
