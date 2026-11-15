import { mkdtemp, writeFile, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ScopedMediaServer,
  type VerifiedPlaybackFile,
} from "../src/main/player/media-server.js";
const roots: string[] = [],
  servers: ScopedMediaServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-playback-"));
  roots.push(root);
  const path = join(root, "fixture.mp3");
  await writeFile(path, "0123456789");
  const handle = await open(path, "r");
  let now = 1000;
  const server = new ScopedMediaServer("musicmute://app", 10000, () => now);
  servers.push(server);
  await server.start();
  const file: VerifiedPlaybackFile = {
    file: handle,
    bytes: 10,
    mime: "audio/mpeg",
    current: vi.fn(async () => {}),
    release: vi.fn(async () => {
      await handle.close();
    }),
  };
  const grant = await server.issue(
    "00000000-0000-4000-8000-000000000001",
    file,
  );
  return {
    server,
    file,
    grant,
    setNow: (value: number) => {
      now = value;
    },
  };
}
it("streams exact bounded ranges and HEAD using a verified pinned descriptor", async () => {
  const f = await fixture();
  const response = await fetch(f.grant.url, {
    headers: { Origin: "musicmute://app", Range: "bytes=2-4" },
  });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
  expect(await response.text()).toBe("234");
  const head = await fetch(f.grant.url, { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe("10");
  expect(await head.text()).toBe("");
  expect(
    (await fetch(f.grant.url, { headers: { Range: "bytes=0-1,3-4" } })).status,
  ).toBe(416);
});
it("a revoked failed release retains the exact grant and denies bytes until an explicit same-owner retry", async () => {
  const f = await fixture(),
    release = vi
      .spyOn(f.file, "release")
      .mockRejectedValueOnce(new Error("PIN_WRITE_UNKNOWN"));
  await expect(f.grant.release()).rejects.toThrow("PIN_WRITE_UNKNOWN");
  expect((await fetch(f.grant.url)).status).toBe(403);
  expect(f.server.activity()).toEqual({ grants: 1, pending: 0, idle: false });
  await f.grant.release();
  expect(release).toHaveBeenCalledTimes(2);
  expect(f.server.activity().idle).toBe(true);
  expect((await fetch(f.grant.url)).status).toBe(403);
});
it("close retries retained grant release after failure while the listener remains shut", async () => {
  const f = await fixture(),
    release = vi
      .spyOn(f.file, "release")
      .mockRejectedValueOnce(new Error("PIN_WRITE_UNKNOWN"));
  await expect(f.server.close()).rejects.toThrow("MEDIA_RELEASE_PENDING");
  expect(f.server.activity().idle).toBe(false);
  await expect(fetch(f.grant.url)).rejects.toThrow();
  await f.server.close();
  await f.server.close();
  expect(release).toHaveBeenCalledTimes(2);
  expect(f.server.activity().idle).toBe(true);
});
it("denies foreign origins, guessed tokens, expired capabilities and revoked owners", async () => {
  const f = await fixture();
  expect(
    (
      await fetch(f.grant.url, {
        headers: { Origin: "https://attacker.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(f.grant.url.replace(/capability=.*/, "capability=guessed")))
      .status,
  ).toBe(403);
  f.setNow(11001);
  expect((await fetch(f.grant.url)).status).toBe(403);
  f.setNow(1000);
  await f.server.revokeOwner("00000000-0000-4000-8000-000000000001");
  expect((await fetch(f.grant.url)).status).toBe(403);
  await f.grant.release();
  expect(f.file.release).toHaveBeenCalledOnce();
});
it("a changed source or owner fence is checked again before every range", async () => {
  const f = await fixture();
  f.file.current = async () => {
    throw new Error("OWNER_CHANGED");
  };
  expect((await fetch(f.grant.url)).status).toBe(403);
});
it("owner revocation during publication cannot publish a late grant", async () => {
  const f = await fixture();
  let resolve!: () => void;
  const handle = await open(join(roots[0]!, "fixture.mp3"), "r");
  const file: VerifiedPlaybackFile = {
    ...f.file,
    file: handle,
    current: async () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
    release: async () => handle.close(),
  };
  const publication = f.server.issue(
    "00000000-0000-4000-8000-000000000001",
    file,
  );
  await vi.waitFor(() => expect(resolve).toBeDefined());
  await f.server.revokeOwner("00000000-0000-4000-8000-000000000001");
  resolve();
  await expect(publication).rejects.toThrow("MEDIA_UNAVAILABLE");
  await file.release();
});
