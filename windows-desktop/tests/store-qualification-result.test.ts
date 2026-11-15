import { expect, it } from "vitest";
import { parseStoreQualificationFailure } from "../src/shared/store-qualification-result.js";
import { STORE_PREPARE_FAILURE_CODES } from "../src/shared/store-prepare-contracts.js";
import { runStorePreparationChild } from "../src/agent/store-prepare.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
const frame = (errorCode: unknown = "GPU_UNSUPPORTED") =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      kind: "store-qualification-failure",
      errorCode,
    }) + "\n",
  );
it.each(STORE_PREPARE_FAILURE_CODES)(
  "receives only closed %s after actual child exit/cleanup elsewhere",
  (code) => {
    expect(parseStoreQualificationFailure(frame(code))).toBe(code);
    expect(
      parseStoreQualificationFailure(
        Buffer.concat([
          Buffer.from('{"stage":"preload-start"}\n'),
          frame(code),
        ]),
      ),
    ).toBe(code);
  },
);
it("does not interpret ordinary successful/progress metadata as failure or Ready", () => {
  expect(
    parseStoreQualificationFailure(
      Buffer.from('{"status":"ok","report":"fixed private output"}\n'),
    ),
  ).toBeUndefined();
  expect(parseStoreQualificationFailure(Buffer.alloc(0))).toBeUndefined();
  expect(
    parseStoreQualificationFailure(Buffer.from("bounded text diagnostic\n")),
  ).toBeUndefined();
});
it.each([
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), frame()]),
  Buffer.concat([Buffer.from([0xff]), frame()]),
  frame().subarray(0, frame().length - 1),
  Buffer.from(frame().toString().replace(/\n$/u, "\r\n")),
  Buffer.concat([Buffer.alloc(262144, 32), frame()]),
  frame("READY"),
  frame(null),
  frame("NETWORK_UNAVAILABLE"),
  Buffer.from(
    '{"version":1,"kind":"store-qualification-failure","errorCode":"BUSY","errorCode":"GPU_UNSUPPORTED"}\n',
  ),
  Buffer.from(
    '{"version":1,"kind":"store-qualification-failure","errorCode":"BUSY","ready":true}\n',
  ),
  Buffer.concat([frame(), Buffer.from("\0\n")]),
])("denies malformed/nonclosed terminal bytes %#", (bytes) =>
  expect(() => parseStoreQualificationFailure(bytes)).toThrow(),
);
it("denies role/entry factories from argv or prototype data before Windows admission", async () => {
  for (const argv of [
    [],
    ["--consumer-config", "C:\\caller"],
    ["--store-session", "extra"],
    ["--store-session "],
  ])
    await expect(runStorePreparationChild(argv)).rejects.toThrow(
      "PREPARE_CONTEXT_INVALID",
    );
  await expect(
    StoreNodeIssuer.prototype.createQualification.call(
      Object.create(StoreNodeIssuer.prototype),
    ),
  ).rejects.toThrow();
  await expect(
    Reflect.apply(
      StoreNodeIssuer.prototype.createQualification,
      Object.create(StoreNodeIssuer.prototype),
      [{ ready: true }],
    ),
  ).rejects.toThrow();
});
