import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcquisitionGate,
  ACQUISITION_REFUSAL_COOLDOWN_MS,
  ACQUISITION_SPACING_MS,
  waitForAcquisitionSpacing,
} from "../src/companion/acquisition-gate.js";

const roots: string[] = [];
const signal = (): AbortSignal => new AbortController().signal;
const refusal = (code: string): Error =>
  Object.assign(new Error(code), { code });
const healthy = (started: number) => ({
  version: 1,
  reason: null,
  blocked_until: 0,
  last_started_at: started,
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-acquisition-gate-"));
  roots.push(root);
  let now = 1_000_000;
  const wait = vi.fn(async (milliseconds: number, abort: AbortSignal) => {
    if (abort.aborted) throw refusal("CANCELLED");
    now += milliseconds;
  });
  return {
    root,
    clock: () => now,
    setClock: (value: number) => {
      now = value;
    },
    wait,
    gate: () => new AcquisitionGate(root, () => now, wait),
    statePath: join(root, "acquisition-state.json"),
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("persistent guest acquisition admission", () => {
  it.each(["SOURCE_BOT_CHALLENGE", "ACQUISITION_RATE_LIMITED"])(
    "persists a fifteen-minute %s cooldown across gate instances",
    async (code) => {
      const f = await fixture();
      const operation = vi.fn(async () => {
        f.setClock(f.clock() + 3_000);
        throw refusal(code);
      });
      await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
        code,
        block_reason: code,
        retry_at: 1_003_000 + ACQUISITION_REFUSAL_COOLDOWN_MS,
      });
      const firstState = JSON.parse(await readFile(f.statePath, "utf8"));
      expect(firstState).toEqual({
        version: 1,
        reason: code,
        blocked_until: f.clock() + ACQUISITION_REFUSAL_COOLDOWN_MS,
        last_started_at: 1_000_000,
      });
      await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
        code: "ACQUISITION_COOLDOWN",
        block_reason: code,
        retry_at: firstState.blocked_until,
      });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(await readFile(f.statePath, "utf8")).toBe(
        JSON.stringify(firstState),
      );
      f.setClock(firstState.blocked_until);
      await expect(
        f.gate().run(signal(), async () => "recovered"),
      ).resolves.toBe("recovered");
      expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual(
        healthy(f.clock()),
      );
    },
  );
  it.each([
    "SOURCE_AUTH_REQUIRED",
    "SOURCE_HTTP_UNAUTHORIZED",
    "SOURCE_HTTP_FORBIDDEN",
    "SOURCE_AGE_RESTRICTED",
    "SOURCE_ACCESS_RESTRICTED",
    "SOURCE_TOKEN_REQUIRED",
    "ACQUISITION_NETWORK_FAILED",
    "CANCELLED",
  ])("does not globally block on %s", async (code) => {
    const f = await fixture();
    await expect(
      f.gate().run(signal(), async () => {
        throw refusal(code);
      }),
    ).rejects.toMatchObject({ code });
    await expect(f.gate().run(signal(), async () => "next")).resolves.toBe(
      "next",
    );
    expect(f.wait).toHaveBeenCalledWith(
      ACQUISITION_SPACING_MS,
      expect.any(AbortSignal),
    );
    expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual(
      healthy(f.clock()),
    );
  });
  it("paces starts through an abortable local wait without rejecting inspect-to-acquire", async () => {
    const f = await fixture();
    const first = vi.fn(async () => "inspection");
    const second = vi.fn(async () => "acquisition");
    await expect(f.gate().run(signal(), first)).resolves.toBe("inspection");
    f.setClock(f.clock() + 2_000);
    await expect(f.gate().run(signal(), second)).resolves.toBe("acquisition");
    expect(f.wait).toHaveBeenCalledOnce();
    expect(f.wait).toHaveBeenCalledWith(3_000, expect.any(AbortSignal));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
  it("rejects concurrent owners immediately and releases the lock after operation failure", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.gate().run(signal(), async () => {
      entered();
      await hold;
      throw refusal("SOURCE_HTTP_FORBIDDEN");
    });
    await ready;
    const second = vi.fn(async () => "unused");
    await expect(f.gate().run(signal(), second)).rejects.toMatchObject({
      code: "ACQUISITION_BUSY",
    });
    expect(second).not.toHaveBeenCalled();
    release();
    await expect(pending).rejects.toMatchObject({
      code: "SOURCE_HTTP_FORBIDDEN",
    });
    f.setClock(f.clock() + ACQUISITION_SPACING_MS);
    await expect(f.gate().run(signal(), second)).resolves.toBe("unused");
  });
  it("uses a cross-process kernel lock that releases when its owner exits", async () => {
    const f = await fixture();
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');fs.openSync(process.argv[1],fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|32,0o600);console.log('ready');setInterval(()=>{},100)",
        join(f.root, "acquisition.lock"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", () => resolve());
        child.once("error", reject);
        child.once("close", () =>
          reject(new Error("fixture lock owner exited")),
        );
      });
      await expect(
        f.gate().run(signal(), async () => "unused"),
      ).rejects.toMatchObject({ code: "ACQUISITION_BUSY" });
      child.kill("SIGTERM");
      await closed;
      await expect(
        f.gate().run(signal(), async () => "released"),
      ).resolves.toBe("released");
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  });
  it("cancels spacing before changing state or invoking the next operation", async () => {
    const f = await fixture();
    await f.gate().run(signal(), async () => {});
    const before = await readFile(f.statePath, "utf8");
    const controller = new AbortController();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = async (delay: number, abort: AbortSignal): Promise<void> => {
      entered();
      await waitForAcquisitionSpacing(delay, abort);
    };
    const operation = vi.fn(async () => {});
    const pending = new AcquisitionGate(f.root, f.clock, wait).run(
      controller.signal,
      operation,
    );
    await waiting;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(f.statePath, "utf8")).toBe(before);
    f.setClock(f.clock() + ACQUISITION_SPACING_MS);
    await expect(
      f.gate().run(signal(), async () => "after cancel"),
    ).resolves.toBe("after cancel");
  });
  it("cancels before locking without changing state", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.gate().run(controller.signal, async () => {}),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await readdir(f.root)).toEqual([]);
  });
  it.each(["SOURCE_BOT_CHALLENGE", "ACQUISITION_RATE_LIMITED"])(
    "retains a delivered %s refusal despite concurrent cancellation and fences restarted gates",
    async (code) => {
      const f = await fixture();
      const during = new AbortController();
      await expect(
        f.gate().run(during.signal, async () => {
          during.abort();
          throw refusal(code);
        }),
      ).rejects.toMatchObject({ code });
      expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual({
        version: 1,
        reason: code,
        blocked_until: f.clock() + ACQUISITION_REFUSAL_COOLDOWN_MS,
        last_started_at: f.clock(),
      });
      const operation = vi.fn(async () => "must not request");
      await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
        code: "ACQUISITION_COOLDOWN",
        block_reason: code,
      });
      expect(operation).not.toHaveBeenCalled();
    },
  );
  it.each(["SOURCE_BOT_CHALLENGE", "ACQUISITION_RATE_LIMITED"])(
    "keeps a durable pending fence after a failed %s cooldown write and filesystem recovery",
    async (code) => {
      const f = await fixture();
      const failure = refusal(code);
      await expect(
        f.gate().run(signal(), async () => {
          expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual({
            ...healthy(f.clock()),
            reason: "ACQUISITION_PENDING",
          });
          await chmod(f.root, 0o500);
          throw failure;
        }),
      ).rejects.toMatchObject({
        code: "ACQUISITION_STATE_INVALID",
        original_refusal: failure,
      });
      expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual({
        ...healthy(f.clock()),
        reason: "ACQUISITION_PENDING",
      });
      await chmod(f.root, 0o700);
      f.setClock(f.clock() + ACQUISITION_SPACING_MS);
      const operation = vi.fn(async () => "must not request");
      await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
        code: "ACQUISITION_COOLDOWN",
        block_reason: "ACQUISITION_INTERRUPTED",
      });
      expect(operation).not.toHaveBeenCalled();
      const recovered = JSON.parse(await readFile(f.statePath, "utf8"));
      expect(recovered).toEqual({
        version: 1,
        reason: "ACQUISITION_INTERRUPTED",
        blocked_until: f.clock() + ACQUISITION_REFUSAL_COOLDOWN_MS,
        last_started_at: 1_000_000,
      });
      await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
        code: "ACQUISITION_COOLDOWN",
        block_reason: "ACQUISITION_INTERRUPTED",
      });
      f.setClock(recovered.blocked_until);
      await expect(f.gate().run(signal(), operation)).resolves.toBe(
        "must not request",
      );
      expect(operation).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual(
        healthy(f.clock()),
      );
    },
  );
  it("keeps interrupted pending state fail closed while the recovery cooldown itself cannot be written", async () => {
    const f = await fixture();
    const raw = JSON.stringify({
      ...healthy(f.clock()),
      reason: "ACQUISITION_PENDING",
    });
    await writeFile(f.statePath, raw, { mode: 0o600 });
    await writeFile(join(f.root, "acquisition.lock"), "", { mode: 0o600 });
    await chmod(f.root, 0o500);
    const operation = vi.fn(async () => {});
    try {
      await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
        code: "ACQUISITION_STATE_INVALID",
      });
      expect(await readFile(f.statePath, "utf8")).toBe(raw);
    } finally {
      await chmod(f.root, 0o700);
    }
    await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
      code: "ACQUISITION_COOLDOWN",
      block_reason: "ACQUISITION_INTERRUPTED",
    });
    expect(operation).not.toHaveBeenCalled();
  });
  it("recovers old interrupted pending state into a fresh bounded cooldown without an extraction", async () => {
    const f = await fixture();
    await writeFile(
      f.statePath,
      JSON.stringify({ ...healthy(0), reason: "ACQUISITION_PENDING" }),
      { mode: 0o600 },
    );
    const operation = vi.fn(async () => {});
    await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
      code: "ACQUISITION_COOLDOWN",
      block_reason: "ACQUISITION_INTERRUPTED",
    });
    expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual({
      version: 1,
      reason: "ACQUISITION_INTERRUPTED",
      blocked_until: f.clock() + ACQUISITION_REFUSAL_COOLDOWN_MS,
      last_started_at: 0,
    });
    expect(operation).not.toHaveBeenCalled();
  });
  it("accepts existing version-one healthy state and clears its new pending phase after success", async () => {
    const f = await fixture();
    await writeFile(
      f.statePath,
      JSON.stringify(healthy(f.clock() - ACQUISITION_SPACING_MS)),
      { mode: 0o600 },
    );
    await expect(
      f.gate().run(signal(), async () => "compatible"),
    ).resolves.toBe("compatible");
    expect(f.wait).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual(
      healthy(f.clock()),
    );
    await expect(f.gate().run(signal(), async () => "next")).resolves.toBe(
      "next",
    );
  });
  it("clears known cancelled completion but leaves an unknown interrupted outcome pending", async () => {
    const f = await fixture();
    const controller = new AbortController();
    await expect(
      f.gate().run(controller.signal, async () => {
        controller.abort();
        return "completed";
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual(
      healthy(f.clock()),
    );
    await expect(
      f.gate().run(signal(), async () => {
        throw new Error("unknown local outcome");
      }),
    ).rejects.toThrow("unknown local outcome");
    expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual({
      ...healthy(f.clock()),
      reason: "ACQUISITION_PENDING",
    });
    const operation = vi.fn(async () => {});
    await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
      code: "ACQUISITION_COOLDOWN",
      block_reason: "ACQUISITION_INTERRUPTED",
    });
    expect(operation).not.toHaveBeenCalled();
  });
  it("publishes only complete private state and retains the persistent lock inode", async () => {
    const f = await fixture();
    await f.gate().run(signal(), async () => {
      expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual({
        ...healthy(f.clock()),
        reason: "ACQUISITION_PENDING",
      });
    });
    expect(JSON.parse(await readFile(f.statePath, "utf8"))).toEqual(
      healthy(f.clock()),
    );
    const lock = await stat(join(f.root, "acquisition.lock"));
    f.setClock(f.clock() + ACQUISITION_SPACING_MS);
    await f
      .gate()
      .run(signal(), async () => {
        throw refusal("SOURCE_BOT_CHALLENGE");
      })
      .catch(() => {});
    const file = await stat(f.statePath);
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.size).toBeLessThan(1024);
    expect(file.nlink).toBe(1);
    expect((await stat(join(f.root, "acquisition.lock"))).ino).toBe(lock.ino);
    expect(await readdir(f.root)).toEqual([
      "acquisition-state.json",
      "acquisition.lock",
    ]);
    expect(await readFile(f.statePath, "utf8")).not.toMatch(
      /https?:|video|cookie|token|url/i,
    );
  });
  it.each(["success", "refusal"])(
    "refuses state replacement during a %s operation without overwriting it",
    async (outcome) => {
      const f = await fixture();
      const replacement = join(f.root, "replacement.json");
      const raw = JSON.stringify({
        ...healthy(f.clock()),
        foreign: "do not overwrite",
      });
      await expect(
        f.gate().run(signal(), async () => {
          await writeFile(replacement, raw, { mode: 0o600 });
          await rename(replacement, f.statePath);
          if (outcome === "refusal") throw refusal("SOURCE_BOT_CHALLENGE");
          return "unused";
        }),
      ).rejects.toMatchObject({ code: "ACQUISITION_STATE_INVALID" });
      expect(await readFile(f.statePath, "utf8")).toBe(raw);
      expect(
        (await readdir(f.root)).filter((name) =>
          name.startsWith(".acquisition-"),
        ),
      ).toEqual([]);
    },
  );
  it("refuses a replaced acquisition directory before persisting a cooldown", async () => {
    const f = await fixture();
    const other = await fixture();
    const moved = join(other.root, "original");
    await expect(
      f.gate().run(signal(), async () => {
        await rename(f.root, moved);
        await symlink(other.root, f.root);
        throw refusal("SOURCE_BOT_CHALLENGE");
      }),
    ).rejects.toMatchObject({ code: "ACQUISITION_STATE_INVALID" });
    expect(await readdir(other.root)).toEqual(["original"]);
  });
  it("rejects a FIFO state without waiting for a writer", async () => {
    const f = await fixture();
    execFileSync("/usr/bin/mkfifo", ["-m", "600", f.statePath]);
    const operation = vi.fn(async () => {});
    await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
      code: "ACQUISITION_STATE_INVALID",
    });
    expect(operation).not.toHaveBeenCalled();
  });
  it.each([
    "not json",
    "[]",
    "null",
    "x".repeat(1025),
    JSON.stringify({ ...healthy(1_000_000), url: "https://private.invalid" }),
    JSON.stringify({ ...healthy(1_000_000), version: 2 }),
    JSON.stringify({ ...healthy(1_000_000), last_started_at: "1000000" }),
    JSON.stringify({ ...healthy(1_000_000), last_started_at: 1_000_001 }),
    JSON.stringify({ ...healthy(1_000_000), blocked_until: 1_000_010 }),
    JSON.stringify({
      ...healthy(1_000_000),
      reason: "SOURCE_AUTH_REQUIRED",
      blocked_until: 1_000_010,
    }),
    JSON.stringify({
      ...healthy(1_000_000),
      reason: "SOURCE_BOT_CHALLENGE",
      blocked_until: 1_000_000,
    }),
    JSON.stringify({
      ...healthy(1_000_000),
      reason: "SOURCE_BOT_CHALLENGE",
      blocked_until: 1_000_001 + ACQUISITION_REFUSAL_COOLDOWN_MS,
    }),
  ])(
    "fails closed on invalid, oversized or clock-anomalous state %s",
    async (raw) => {
      const f = await fixture();
      await writeFile(f.statePath, raw, { mode: 0o600 });
      const operation = vi.fn(async () => {});
      await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
        code: "ACQUISITION_STATE_INVALID",
      });
      expect(operation).not.toHaveBeenCalled();
      expect(await readFile(f.statePath, "utf8")).toBe(raw);
    },
  );
  it.each(["root", "state", "lock", "hardlink", "permissions"])(
    "rejects unsafe %s ownership",
    async (kind) => {
      const f = await fixture();
      let root = f.root;
      if (kind === "root") {
        const other = await fixture();
        root = join(other.root, "alias");
        await symlink(f.root, root);
      } else if (kind === "lock" || kind === "state") {
        const target = join(f.root, "target");
        await writeFile(target, JSON.stringify(healthy(f.clock())), {
          mode: 0o600,
        });
        await symlink(
          target,
          kind === "lock" ? join(f.root, "acquisition.lock") : f.statePath,
        );
      } else {
        await writeFile(f.statePath, JSON.stringify(healthy(f.clock())), {
          mode: 0o600,
        });
        if (kind === "hardlink") await link(f.statePath, join(f.root, "other"));
        else await chmod(f.statePath, 0o644);
      }
      const operation = vi.fn(async () => {});
      await expect(
        new AcquisitionGate(root, f.clock, f.wait).run(signal(), operation),
      ).rejects.toMatchObject({ code: "ACQUISITION_STATE_INVALID" });
      expect(operation).not.toHaveBeenCalled();
    },
  );
  it("fails closed when the clock rolls back during admission or a refused operation", async () => {
    const f = await fixture();
    await f.gate().run(signal(), async () => {});
    const operation = vi.fn(async () => {});
    const brokenWait = async (): Promise<void> => {
      f.setClock(f.clock() - 1);
    };
    await expect(
      new AcquisitionGate(f.root, f.clock, brokenWait).run(signal(), operation),
    ).rejects.toMatchObject({ code: "ACQUISITION_STATE_INVALID" });
    expect(operation).not.toHaveBeenCalled();
    f.setClock(2_000_000);
    await expect(
      f.gate().run(signal(), async () => {
        f.setClock(f.clock() - 1);
        throw refusal("SOURCE_BOT_CHALLENGE");
      }),
    ).rejects.toMatchObject({ code: "ACQUISITION_STATE_INVALID" });
    await expect(f.gate().run(signal(), operation)).rejects.toMatchObject({
      code: "ACQUISITION_STATE_INVALID",
    });
  });
  it("rejects unsafe clocks and early wakeups without an operation", async () => {
    const f = await fixture();
    const operation = vi.fn(async () => {});
    await expect(
      new AcquisitionGate(f.root, () => NaN, f.wait).run(signal(), operation),
    ).rejects.toMatchObject({ code: "ACQUISITION_STATE_INVALID" });
    await f.gate().run(signal(), async () => {});
    await expect(
      new AcquisitionGate(f.root, f.clock, async () => {}).run(
        signal(),
        operation,
      ),
    ).rejects.toMatchObject({ code: "ACQUISITION_STATE_INVALID" });
    expect(operation).not.toHaveBeenCalled();
  });
});
