import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  readAppControlFrame,
  runAppControlSession,
} from "../src/cli/app-control.js";
import { APP_CONTROL_REQUEST_LIMIT } from "../src/platform/macos/app-control-protocol.js";

const requestId = "7161b679-e633-4280-bbb5-831992549700";
const request = {
  protocol_version: 1,
  request_id: requestId,
  type: "COMMAND",
  command: "versions",
  parameters: {},
};

describe("private controller JSONL entry", () => {
  it("handles fragmented UTF-8 and keeps version replies structured", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const running = runAppControlSession(input, output, {
      versions: async () => ({ cliVersion: "0.1.3", runtimeVersion: null }),
    });
    const bytes = Buffer.from(`${JSON.stringify(request)}\n`);
    input.write(bytes.subarray(0, 10));
    input.end(bytes.subarray(10));
    await running;
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
      protocol_version: 1,
      request_id: requestId,
      type: "RESULT",
      payload: { cliVersion: "0.1.3", runtimeVersion: null },
    });
  });

  it.each([
    Buffer.from("{}"),
    Buffer.from("{}\n{}\n"),
    Buffer.from([0xff, 10]),
    Buffer.alloc(APP_CONTROL_REQUEST_LIMIT + 1, 120),
  ])(
    "rejects truncated, multiple, invalid UTF-8 and oversized frames",
    async (bytes) => {
      await expect(
        readAppControlFrame(Readable.from([bytes])),
      ).rejects.toBeInstanceOf(Error);
    },
  );

  it("never reflects a malformed request or raw exception into stdout", async () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    await runAppControlSession(
      Readable.from(['{"credential":"private-secret"}\n']),
      output,
    );
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text).not.toContain("private-secret");
    expect(JSON.parse(text)).toMatchObject({
      type: "ERROR",
      error_code: "INVALID_REQUEST",
    });
  });

  it("rejects a second frame arriving later without executing a second command", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    let finish: () => void = () => undefined;
    let admitted = false;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = runAppControlSession(input, output, {
      versions: async () => {
        admitted = true;
        await pending;
        return { cliVersion: "0.1.3" };
      },
    });
    input.write(`${JSON.stringify(request)}\n`);
    while (!admitted) await new Promise((resolve) => setTimeout(resolve, 1));
    input.end(
      `${JSON.stringify({ ...request, command: "uninstall", parameters: { purge: true } })}\n`,
    );
    finish();
    await running;
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toMatchObject({
      type: "ERROR",
      error_code: "INVALID_REQUEST",
    });
  });
});
