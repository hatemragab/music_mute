import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserFrameDecoder,
  encodeBrowserFrame,
  MAX_BROWSER_FRAME,
} from "../src/main/browser/framing.js";
import {
  extensionIdFromManifest,
  loadBrowserIntegrationManifest,
} from "../src/main/browser/registration.js";
import { unavailableBrowserReply } from "../src/main/browser/unavailable.js";
import { WindowsBrowserService } from "../src/main/browser/service.js";
import type {
  PersonalCommand,
  PersonalJobView,
} from "../src/shared/personal-contracts.js";
import type { PersonalReply } from "../src/main/personal/session-port.js";
import type { NativeReply } from "../../chrome-extension/src/shared/protocol.js";

const command = (type: string, payload: unknown = {}) => ({
  protocol_version: 1,
  request_id: randomUUID(),
  type,
  payload,
});
describe("Windows Chrome framing and immutable shared extension identity", () => {
  it("decodes split headers/bodies, multiple frames and Unicode without CRLF conversion", () => {
    const input = [
        { value: "العربية\r\nMusicMute", seconds: 12.5 },
        { value: "second" },
      ],
      bytes = Buffer.concat(input.map(encodeBrowserFrame)),
      decoder = new BrowserFrameDecoder();
    expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(2, 5))).toEqual([]);
    expect(decoder.push(bytes.subarray(5))).toEqual(input);
    decoder.finish();
  });
  it("rejects oversized/invalid UTF8/JSON frames, stray logs and truncated input", () => {
    const oversize = Buffer.alloc(4);
    oversize.writeUInt32LE(MAX_BROWSER_FRAME + 1);
    for (const value of [
      oversize,
      Buffer.from("debug log\n"),
      Buffer.from([2, 0, 0, 0, 0xc0, 0xaf]),
      Buffer.from([2, 0, 0, 0, 0x7b, 0x7b]),
    ])
      expect(() => new BrowserFrameDecoder().push(value)).toThrow(
        "FRAME_INVALID",
      );
    const decoder = new BrowserFrameDecoder();
    decoder.push(Buffer.from([2, 0, 0]));
    expect(() => decoder.finish()).toThrow("FRAME_TRUNCATED");
  });
  it("uses the existing shared extension key and verifies actual packaged entry bytes", async () => {
    const extension = JSON.parse(
      await readFile(
        new URL(
          "../../chrome-extension/src/extension/static/manifest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(extensionIdFromManifest(extension)).toBe(
      "acmgefmmndomcpdlgnafkjbgobinllep",
    );
    expect(() => extensionIdFromManifest({ ...extension, key: "bad" })).toThrow(
      "BROWSER_HOST_UNAVAILABLE",
    );
    const root = await mkdtemp(join(tmpdir(), "MusicMute browser العربية "));
    try {
      await mkdir(join(root, "native"));
      await mkdir(join(root, "extension"));
      const entry = Buffer.from("// synthetic browser entry\n"),
        manifest = {
          version: 1,
          extensionId: extensionIdFromManifest(extension),
          hostSha256: "a".repeat(64),
          hostBytes: 32,
          entrySha256: createHash("sha256").update(entry).digest("hex"),
          entryBytes: entry.length,
        };
      await writeFile(join(root, "native", "browser-host.cjs"), entry);
      await writeFile(
        join(root, "extension", "manifest.json"),
        JSON.stringify(extension),
      );
      await writeFile(
        join(root, "native", "browser-manifest.json"),
        JSON.stringify(manifest),
      );
      expect(await loadBrowserIntegrationManifest(root)).toEqual(manifest);
      await writeFile(
        join(root, "native", "browser-host.cjs"),
        Buffer.from("tampered"),
      );
      await expect(loadBrowserIntegrationManifest(root)).rejects.toThrow(
        "BROWSER_HOST_UNAVAILABLE",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("returns bounded Setup replies with request ID when active bootstrap is unavailable", () => {
    const hello = command("HELLO", { capabilities: ["error_context_v1"] });
    expect(unavailableBrowserReply(hello)).toMatchObject({
      type: "HELLO",
      request_id: hello.request_id,
      payload: {
        ready: false,
        error_code: "LOCAL_INSTALL_REQUIRED",
        platform: "win32",
        arch: "x64",
      },
    });
    expect(
      unavailableBrowserReply(
        command("START", {
          video_id: "abcdefghijk",
          duration_seconds: 12.5,
          provider: "LOCAL_WINDOWS",
        }),
      ),
    ).toMatchObject({
      type: "ERROR",
      payload: { error_code: "LOCAL_INSTALL_REQUIRED" },
    });
    expect(() =>
      unavailableBrowserReply({ ...hello, secret: "never reflect" }),
    ).toThrow("INVALID_COMMAND");
  });
});

function fixture() {
  const writes: NativeReply[] = [];
  let jobs: PersonalJobView[] = [];
  let changed: ((reply: PersonalReply) => void) | undefined;
  const requests: PersonalCommand[] = [];
  const personal = vi.fn(
    async (input: PersonalCommand): Promise<PersonalReply> => {
      requests.push(input);
      const base = {
        version: 1 as const,
        requestId: input.requestId,
        ok: true,
      };
      if (input.action === "wait_changes")
        return new Promise((resolve) => {
          changed = resolve;
        });
      if (input.action === "submit") {
        const job: PersonalJobView = {
          id: randomUUID(),
          ownerId: input.submission.ownerId,
          state: "preparing",
          stage: "metadata",
          progress: null,
          name: "Fixture",
          error: null,
          original: null,
          vocals: null,
        };
        jobs = [job];
        return { ...base, job };
      }
      return { ...base, jobs };
    },
  );
  const release = vi.fn(async () => {}),
    media = {
      issue: vi.fn(async () => ({
        url: "http://127.0.0.1:1234/media/opaque",
        release,
      })),
      close: vi.fn(async () => {}),
    },
    disconnected = vi.fn();
  const service = new WindowsBrowserService({
    session: { personal },
    media,
    write: async (reply) => {
      writes.push(reply);
    },
    onDisconnected: disconnected,
  });
  return {
    service,
    personal,
    media,
    release,
    disconnected,
    writes,
    requests,
    setJobs: (value: PersonalJobView[]) => {
      jobs = value;
    },
    change: () => changed,
  };
}
describe("authenticated Windows browser session bridge", () => {
  it("reports ready only after real session response succeeds", async () => {
    const f = fixture();
    f.personal.mockResolvedValueOnce({
      version: 1,
      requestId: randomUUID(),
      ok: false,
      error: "PREPARE_REQUIRED",
    });
    await f.service.command(command("HELLO"));
    expect(f.writes[0]).toMatchObject({
      type: "HELLO",
      payload: { ready: false, error_code: "LOCAL_INSTALL_REQUIRED" },
    });
    await f.service.close();
  });
  it("keeps personal rights/owner/recipe and refuses browser fleet commands and implicit cloud fallback", async () => {
    const f = fixture();
    await f.service.command(
      command("START", {
        video_id: "abcdefghijk",
        duration_seconds: 12.5,
        provider: "LOCAL_WINDOWS",
      }),
    );
    expect(f.requests[0]).toMatchObject({
      action: "submit",
      submission: {
        ownerId: f.service.ownerId,
        rightsConfirmed: true,
        recipeId: "kim-vocals-v2",
        input: { kind: "youtube", videoId: "abcdefghijk" },
      },
    });
    await f.service.command(
      command("START", {
        video_id: "abcdefghijk",
        duration_seconds: 12,
        provider: "ONLINE_MUSICMUTE",
      }),
    );
    expect(f.writes.at(-1)).toMatchObject({
      type: "ERROR",
      payload: { error_code: "ACCOUNT_SESSION_UNAVAILABLE" },
    });
    await expect(f.service.command(command("FLEET_START"))).rejects.toThrow(
      "INVALID_COMMAND",
    );
    await f.service.command(command("CANCEL", { job_id: randomUUID() }));
    expect(f.writes.at(-1)).toMatchObject({
      type: "ERROR",
      payload: { error_code: "OWNER_DETACHED" },
    });
    await f.service.close();
  });
  it("publishes event-driven progress and revokes media on current authorized snapshot changes", async () => {
    const f = fixture();
    await f.service.command(
      command("START", {
        video_id: "abcdefghijk",
        duration_seconds: 12,
        provider: "LOCAL_WINDOWS",
      }),
    );
    await vi.waitFor(() => expect(f.change()).toBeTypeOf("function"));
    const submitted = f.requests.find(
      (row) => row.action === "submit",
    ) as Extract<PersonalCommand, { action: "submit" }>;
    const first = (f.writes[0] as Extract<NativeReply, { type: "JOB" }>)
      .payload!;
    const ready: PersonalJobView = {
      id: first.job_id,
      ownerId: submitted.submission.ownerId,
      state: "ready",
      stage: "output-validation",
      progress: 1,
      name: "Fixture",
      error: null,
      original: null,
      vocals: {
        id: randomUUID(),
        kind: "vocals",
        name: "Fixture.wav",
        bytes: 64,
        sha256: "a".repeat(64),
        durationSeconds: 12,
        contentType: "audio/wav",
      },
    };
    const waiting = f.requests.at(-1)!;
    f.change()!({
      version: 1,
      requestId: waiting.requestId,
      ok: true,
      changeVersion: 2,
      instanceId: randomUUID(),
      jobs: [ready],
    });
    await vi.waitFor(() => expect(f.media.issue).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(f.writes.at(-1)).toMatchObject({
        type: "JOB",
        payload: {
          state: "READY",
          provider: "LOCAL_WINDOWS",
          media: { trim_enabled: false },
        },
      }),
    );
    f.setJobs([]);
    expect(await f.service.authorizeMedia(ready.id, ready.vocals!.sha256)).toBe(
      false,
    );
    expect(f.release).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.writes)).not.toMatch(
      /S-1-5|firebase|refresh_token|fleet_ticket|C:\\\\/u,
    );
    await f.service.close();
    expect(f.requests.at(-1)).toMatchObject({
      action: "detach",
      ownerId: f.service.ownerId,
    });
  });
  it("watcher failure disconnects and close still detaches exact browser owner", async () => {
    const f = fixture();
    await f.service.command(command("HELLO"));
    await vi.waitFor(() => expect(f.change()).toBeTypeOf("function"));
    f.change()!({
      version: 1,
      requestId: randomUUID(),
      ok: false,
      error: "OWNER_DETACHED",
    });
    await vi.waitFor(() => expect(f.disconnected).toHaveBeenCalledOnce());
    await f.service.close();
    expect(f.requests.at(-1)).toMatchObject({
      action: "detach",
      ownerId: f.service.ownerId,
    });
    expect(f.media.close).toHaveBeenCalled();
  });
});
