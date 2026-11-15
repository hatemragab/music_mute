import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { nodePrivateFileFixture } from "./private-file-port-fixture.js";
import {
  transferArtifact,
  type TransferCheckpoint,
  type TransferCheckpointPort,
} from "../src/main/prepare/artifact-transfer.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const bytes = Buffer.from("synthetic-runtime-checksummed-bytes");
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const pin = {
  binding: "a".repeat(64),
  url: "https://fixture.invalid/runtime.zip",
  bytes: bytes.length,
  sha256: sha(bytes),
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-transfer-code-"));
  roots.push(root);
  const path = join(root, "runtime.part"),
    file = await open(path, "wx+");
  let saved: TransferCheckpoint | null = null;
  const checkpoints: TransferCheckpointPort = {
    read: async () => saved,
    write: async (row) => {
      saved = structuredClone(row);
    },
    remove: async () => {
      saved = null;
    },
  };
  return {
    path,
    file,
    destination: nodePrivateFileFixture(file),
    checkpoints,
    saved: () => saved,
    options: {
      signal: new AbortController().signal,
      checkpoints,
      permittedUrl: (url: string) => new URL(url),
      assertCurrentFile: async () => {},
      onProgress: vi.fn(),
    },
  };
}
function truncated(etag = '"fixture-stable"') {
  let pull = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pull++ === 0) controller.enqueue(bytes.subarray(0, 8));
        else controller.error(new Error("synthetic interrupted network"));
      },
    }),
    { headers: { ETag: etag, "Content-Length": String(bytes.length) } },
  );
}
it("fresh transfer verifies exact bytes/digest and measured progress without credentials", async () => {
  const f = await fixture();
  try {
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "manual",
      });
      expect(init.headers).toEqual({
        Accept: "application/octet-stream",
        "Accept-Encoding": "identity",
      });
      return new Response(bytes);
    });
    await transferArtifact(f.destination, pin, {
      ...f.options,
      fetch: fetcher as typeof fetch,
    });
    expect(await readFile(f.path)).toEqual(bytes);
    expect(f.saved()).toBeNull();
    expect(f.options.onProgress).toHaveBeenLastCalledWith(
      bytes.length,
      bytes.length,
    );
  } finally {
    await f.file.close();
  }
});
it("resumes a rehashed protected prefix with the same strong ETag and exact range", async () => {
  const f = await fixture();
  try {
    await expect(
      transferArtifact(f.destination, pin, {
        ...f.options,
        fetch: (async () => truncated()) as typeof fetch,
      }),
    ).rejects.toThrow("NETWORK_UNAVAILABLE");
    expect(f.saved()).toMatchObject({
      bytes: 8,
      etag: '"fixture-stable"',
      sha256: sha(bytes.subarray(0, 8)),
    });
    await f.file.write(Buffer.from("uncheckpointed"), 0, 14, 8);
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.headers).toMatchObject({
        Range: "bytes=8-",
        "If-Range": '"fixture-stable"',
      });
      return new Response(bytes.subarray(8), {
        status: 206,
        headers: {
          ETag: '"fixture-stable"',
          "Content-Range": `bytes 8-${bytes.length - 1}/${bytes.length}`,
          "Content-Length": String(bytes.length - 8),
        },
      });
    });
    await transferArtifact(f.destination, pin, {
      ...f.options,
      fetch: fetcher as typeof fetch,
    });
    expect(await readFile(f.path)).toEqual(bytes);
    expect(f.saved()).toBeNull();
  } finally {
    await f.file.close();
  }
});
it("range ignored with 200 restarts from byte zero instead of appending", async () => {
  const f = await fixture();
  try {
    await expect(
      transferArtifact(f.destination, pin, {
        ...f.options,
        fetch: (async () => truncated()) as typeof fetch,
      }),
    ).rejects.toThrow();
    await transferArtifact(f.destination, pin, {
      ...f.options,
      fetch: (async () =>
        new Response(bytes, {
          headers: { ETag: '"replacement"' },
        })) as typeof fetch,
    });
    expect(await readFile(f.path)).toEqual(bytes);
  } finally {
    await f.file.close();
  }
});
it.each([
  {
    "Content-Range": `bytes 7-${bytes.length - 1}/${bytes.length}`,
    ETag: '"fixture-stable"',
  },
  {
    "Content-Range": `bytes 8-${bytes.length - 1}/${bytes.length}`,
    ETag: '"changed"',
  },
  {
    "Content-Range": `bytes 8-${bytes.length - 1}/${bytes.length + 1}`,
    ETag: '"fixture-stable"',
  },
])("refuses changed validator/range before appending (%j)", async (headers) => {
  const f = await fixture();
  try {
    await expect(
      transferArtifact(f.destination, pin, {
        ...f.options,
        fetch: (async () => truncated()) as typeof fetch,
      }),
    ).rejects.toThrow();
    await expect(
      transferArtifact(f.destination, pin, {
        ...f.options,
        fetch: (async () =>
          new Response(bytes.subarray(8), {
            status: 206,
            headers,
          })) as typeof fetch,
      }),
    ).rejects.toThrow("INTEGRITY_INVALID");
    expect(await readFile(f.path)).toEqual(bytes.subarray(0, 8));
    expect(f.saved()).toBeNull();
  } finally {
    await f.file.close();
  }
});
it("does not resume a weak validator and restarts an uncheckpointed partial", async () => {
  const f = await fixture();
  try {
    await expect(
      transferArtifact(f.destination, pin, {
        ...f.options,
        fetch: (async () => truncated('W/"weak"')) as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(f.saved()).toBeNull();
    await transferArtifact(f.destination, pin, {
      ...f.options,
      fetch: (async (_url: URL, init: RequestInit) => {
        expect(init.headers).not.toHaveProperty("Range");
        return new Response(bytes);
      }) as typeof fetch,
    });
    expect(await readFile(f.path)).toEqual(bytes);
  } finally {
    await f.file.close();
  }
});
it("refuses prefix tampering and does not make any network request", async () => {
  const f = await fixture();
  try {
    await expect(
      transferArtifact(f.destination, pin, {
        ...f.options,
        fetch: (async () => truncated()) as typeof fetch,
      }),
    ).rejects.toThrow();
    await f.file.write(Buffer.from("wrong!!!"), 0, 8, 0);
    const fetcher = vi.fn();
    await expect(
      transferArtifact(f.destination, pin, { ...f.options, fetch: fetcher }),
    ).rejects.toThrow("INTEGRITY_INVALID");
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await f.file.close();
  }
});
it.each([
  new Response(bytes, {
    status: 206,
    headers: { "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
  }),
  new Response(bytes, { headers: { "Content-Encoding": "gzip" } }),
  new Response(Buffer.concat([bytes, Buffer.from("extra")])),
  new Response(Buffer.alloc(bytes.length, 0)),
])(
  "rejects unsolicited partial, encoding, oversize and full bad digest",
  async (response) => {
    const f = await fixture();
    try {
      await expect(
        transferArtifact(f.destination, pin, {
          ...f.options,
          fetch: (async () => response) as typeof fetch,
        }),
      ).rejects.toThrow("INTEGRITY_INVALID");
      expect(f.saved()).toBeNull();
    } finally {
      await f.file.close();
    }
  },
);
it("keeps a strong checkpoint on truncated EOF and validates complete local bytes offline", async () => {
  const f = await fixture();
  try {
    await expect(
      transferArtifact(f.destination, pin, {
        ...f.options,
        fetch: (async () =>
          new Response(bytes.subarray(0, 8), {
            headers: { ETag: '"stable"' },
          })) as typeof fetch,
      }),
    ).rejects.toThrow("NETWORK_UNAVAILABLE");
    expect(f.saved()).toMatchObject({ bytes: 8 });
    await f.file.truncate(0);
    await f.file.write(bytes, 0, bytes.length, 0);
    const fetcher = vi.fn();
    await transferArtifact(f.destination, pin, {
      ...f.options,
      fetch: fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.saved()).toBeNull();
  } finally {
    await f.file.close();
  }
});
it("cancellation after measured prefix preserves only verified resume checkpoint", async () => {
  const f = await fixture(),
    abort = new AbortController();
  try {
    await expect(
      transferArtifact(f.destination, pin, {
        ...f.options,
        signal: abort.signal,
        onProgress: (written) => {
          if (written) abort.abort();
        },
        fetch: (async () =>
          new Response(bytes.subarray(0, 8), {
            headers: { ETag: '"stable"' },
          })) as typeof fetch,
      }),
    ).rejects.toThrow("PREPARE_INTERRUPTED");
    expect(f.saved()).toMatchObject({ bytes: 8 });
    expect(await readFile(f.path)).toEqual(bytes.subarray(0, 8));
  } finally {
    await f.file.close();
  }
});
it("real descriptor short writes are accumulated without losing bytes or checksum proof", async () => {
  const f = await fixture(),
    original = f.file.write.bind(f.file),
    write = vi.spyOn(f.file, "write");
  write.mockImplementation((async (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) =>
    original(
      buffer,
      offset,
      Math.min(3, length),
      position,
    )) as typeof f.file.write);
  try {
    await transferArtifact(f.destination, pin, {
      ...f.options,
      fetch: (async () => new Response(bytes)) as typeof fetch,
    });
    expect(await readFile(f.path)).toEqual(bytes);
    expect(write.mock.calls.length).toBeGreaterThan(1);
    expect(f.saved()).toBeNull();
  } finally {
    write.mockRestore();
    await f.file.close();
  }
});
it("midstream ENOSPC reports low disk and retains only an actual hash-checked prefix for later exact resume", async () => {
  const f = await fixture(),
    original = f.file.write.bind(f.file),
    write = vi.spyOn(f.file, "write");
  let writes = 0;
  write.mockImplementation((async (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => {
    if (++writes === 3)
      throw Object.assign(new Error("synthetic disk exhaustion"), {
        code: "ENOSPC",
      });
    return original(buffer, offset, Math.min(3, length), position);
  }) as typeof f.file.write);
  try {
    await expect(
      transferArtifact(f.destination, pin, {
        ...f.options,
        fetch: (async () =>
          new Response(bytes, {
            headers: { ETag: '"stable"' },
          })) as typeof fetch,
      }),
    ).rejects.toThrow("LOW_DISK");
    const prefix = bytes.subarray(0, 6);
    expect(await readFile(f.path)).toEqual(prefix);
    expect(f.saved()).toMatchObject({ bytes: 6, sha256: sha(prefix) });
    write.mockRestore();
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.headers).toMatchObject({
        Range: "bytes=6-",
        "If-Range": '"stable"',
      });
      return new Response(bytes.subarray(6), {
        status: 206,
        headers: {
          ETag: '"stable"',
          "Content-Range": `bytes 6-${bytes.length - 1}/${bytes.length}`,
        },
      });
    });
    await transferArtifact(f.destination, pin, {
      ...f.options,
      fetch: fetcher as typeof fetch,
    });
    expect(await readFile(f.path)).toEqual(bytes);
    expect(f.saved()).toBeNull();
  } finally {
    write.mockRestore();
    await f.file.close();
  }
});
