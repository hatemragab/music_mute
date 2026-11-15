import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsumerNativeChildTransport,
  createConsumerNativeTransport,
  parseStoreBootstrapDiagnosticLine,
  STORE_BOOTSTRAP_DIAGNOSTIC_PHASES,
  type ConsumerNativeTransport,
} from "../src/platform/windows/consumer-native-transport.js";

const transports: ConsumerNativeTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

describe("closed development bootstrap observations", () => {
  const line =
    "MMDEV1 phase=child-assign code=4 win32=5 wait=4294967295 exit=259 active=0 assigned=1 listed=0\n";
  it.each(STORE_BOOTSTRAP_DIAGNOSTIC_PHASES)(
    "accepts the bounded fixed phase %s without code authority",
    (phase) => {
      const value = parseStoreBootstrapDiagnosticLine(
        Buffer.from(line.replace("child-assign", phase)),
      );
      expect(value).toEqual({
        phase,
        code: 4,
        win32: 5,
        wait: 4294967295,
        exit: 259,
        active: 0,
        assigned: 1,
        listed: 0,
      });
      expect(Object.isFrozen(value)).toBe(true);
    },
  );
  it.each([
    line.replace("child-assign", "private-path"),
    line.replace("code=4", "code=12"),
    line.replace("win32=5", "win32=4294967296"),
    line.replace("win32=5", "win32=-1"),
    line.replace("win32=5", "win32=05"),
    line.replace("win32=5", "win32=5.0"),
    line.replace(" win32=5", " note=private win32=5"),
    line.replace("\n", "\r\n"),
    line.replace("\n", ""),
    line + "\n",
    "private-prefix " + line,
    line.replace("phase=child-assign code=4", "code=4 phase=child-assign"),
    "x".repeat(257),
  ])(
    "discards malformed, expanded and private-bearing diagnostics",
    (value) => {
      expect(
        parseStoreBootstrapDiagnosticLine(Buffer.from(value)),
      ).toBeUndefined();
    },
  );
  it("collects split stderr lines, discards untrusted text and exposes only immutable copies after EOF", async () => {
    const transport = fixture(
      String.raw`const diagnostic=${JSON.stringify(line)};process.stderr.write('synthetic-private-line\n');for (const byte of Buffer.from(diagnostic))process.stderr.write(Buffer.from([byte]));process.stderr.write(diagnostic.repeat(6));process.stderr.write('unterminated-private-text');process.stdout.write(JSON.stringify({version:1,id:request.id,ok:false,error:{code:'HELPER_UNAVAILABLE'}})+'\n');`,
    );
    await expect(transport.request("store_boot", {})).rejects.toThrow(
      "HELPER_UNAVAILABLE",
    );
    await transport.close();
    const first = transport.storeBootstrapDiagnostics;
    const second = transport.storeBootstrapDiagnostics;
    expect(first).toHaveLength(4);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(JSON.stringify(first)).not.toContain("private");
    expect(first[0]?.phase).toBe("child-assign");
  });
  it("preserves the total stderr overflow abort for every pending request", async () => {
    const transport = fixture(
      String.raw`process.stderr.write('x'.repeat(32769));`,
    );
    const first = transport.request("store_boot", {});
    const second = transport.request("identity", {});
    await expect(first).rejects.toThrow("FRAME_TOO_LARGE");
    await expect(second).rejects.toThrow("FRAME_TOO_LARGE");
    expect(transport.storeBootstrapDiagnostics).toEqual([]);
    await transport.close();
  });
});
function fixture(body: string): ConsumerNativeChildTransport {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import readline from 'node:readline'; const reader=readline.createInterface({input:process.stdin}); reader.on('line', (line)=> {const request=JSON.parse(line); ${body}});`,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: {} },
  );
  const transport = new ConsumerNativeChildTransport(child);
  transports.push(transport);
  return transport;
}
describe("consumer helper framing with isolated Node code fixture", () => {
  it("handles UTF-8 chunk splitting and concurrent request IDs", async () => {
    const transport = fixture(
      String.raw`const response=Buffer.from(JSON.stringify({version:1,id:request.id,ok:true,result:{value:'العربية 🚀'}})+'\n'); for(const byte of response)process.stdout.write(Buffer.from([byte]));`,
    );
    const replies = await Promise.all([
      transport.request("identity", {}),
      transport.request("identity", {}),
    ]);
    expect(replies).toEqual([{ value: "العربية 🚀" }, { value: "العربية 🚀" }]);
  });
  it("maps native errors without forwarding arbitrary stderr or error fields", async () => {
    const transport = fixture(
      String.raw`process.stderr.write('synthetic-private-diagnostic');process.stdout.write(JSON.stringify({version:1,id:request.id,ok:false,error:{code:'VAULT_CORRUPT',message:'synthetic-secret',stack:'synthetic-stack'}})+'\n');`,
    );
    const error = await transport
      .request("vault_get", { namespace: "account", key: "fixture" })
      .catch((value: unknown) => value);
    expect(JSON.stringify(error)).toBe('{"code":"VAULT_CORRUPT"}');
  });
  it("matches out-of-order asynchronous pipe completion without blocking another request", async () => {
    const transport = fixture(
      String.raw`setTimeout(()=>process.stdout.write(JSON.stringify({version:1,id:request.id,ok:true,result:{operation:request.operation}})+'\n'),request.operation==='pipe_connect'?50:0);`,
    );
    const slow = transport.request("pipe_connect", {});
    expect(await transport.request("identity", {})).toEqual({
      operation: "identity",
    });
    expect(await slow).toEqual({ operation: "pipe_connect" });
  });
  it.each([
    `({version:2,id:request.id,ok:true,result:{}})`,
    `({version:1,id:request.id+1,ok:true,result:{}})`,
    `({version:1,id:request.id,ok:false,error:{code:'UNRECOGNIZED',message:'secret'}})`,
    `({version:1,id:request.id,ok:false,error:null})`,
    `({version:1,id:request.id,ok:true})`,
  ])("closes malformed/version-incompatible replies", async (reply) => {
    const transport = fixture(
      String.raw`process.stdout.write(JSON.stringify(${reply})+'\n');`,
    );
    await expect(transport.request("identity", {})).rejects.toThrow(
      "PROTOCOL_MISMATCH",
    );
    await expect(transport.request("identity", {})).rejects.toThrow(
      "HELPER_UNAVAILABLE",
    );
  });
  it("fails closed on duplicate response/replay", async () => {
    const transport = fixture(
      String.raw`const response=JSON.stringify({version:1,id:request.id,ok:true,result:{}})+'\n';process.stdout.write(response+response);`,
    );
    await transport.request("identity", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(transport.request("identity", {})).rejects.toThrow(
      "HELPER_UNAVAILABLE",
    );
  });
  it("rejects duplicate JSON keys before a self-authorizing native result can be consumed", async () => {
    const transport = fixture(
      String.raw`process.stdout.write('{"version":1,"id":'+request.id+',"ok":false,"ok":true,"result":{"signatureKind":0,"signatureKind":3}}\n');`,
    );
    await expect(transport.request("store_boot", {})).rejects.toThrow(
      "PROTOCOL_MISMATCH",
    );
    await expect(transport.request("identity", {})).rejects.toThrow(
      "HELPER_UNAVAILABLE",
    );
  });
  it("kills a timed-out helper, rejects every pending operation and never retries a secret write", async () => {
    const transport = fixture(String.raw`void request;`);
    const first = transport.request(
      "vault_put",
      { bytes_base64: "c3ludGhldGlj" },
      100,
    );
    const second = transport.request("identity", {}, 1000);
    await expect(first).rejects.toThrow("TIMEOUT");
    await expect(second).rejects.toThrow("TIMEOUT");
    await expect(transport.request("identity", {})).rejects.toThrow(
      "HELPER_UNAVAILABLE",
    );
  });
  it("bounds request and response bytes", async () => {
    const transport = fixture(
      String.raw`process.stdout.write('x'.repeat(65537));`,
    );
    await expect(
      transport.request("identity", { data: "x".repeat(65536) }),
    ).rejects.toThrow("FRAME_TOO_LARGE");
    await expect(transport.request("identity", {})).rejects.toThrow(
      "FRAME_TOO_LARGE",
    );
  });
  it("rejects malformed UTF-8 instead of replacing bytes", async () => {
    const transport = fixture(
      String.raw`process.stdout.write(Buffer.from([0xff,10]));`,
    );
    await expect(transport.request("identity", {})).rejects.toThrow(
      "PROTOCOL_MISMATCH",
    );
  });
  it("does not start a Windows helper on a non-Windows host", async () => {
    if (process.platform === "win32") return;
    await expect(
      createConsumerNativeTransport("C:\\fixture\\native.exe", "a".repeat(64)),
    ).rejects.toThrow("UNSUPPORTED_HOST");
  });
});
