import { constants, watch, type FSWatcher } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { LocalLibraryOwner } from "./sync-outbox.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATE_FILE = "account-state.json";

/** Native identity-only scope. Missing initial state is guest; unsafe state is never guest. */
export async function readAccountState(
  root: string,
): Promise<LocalLibraryOwner | undefined> {
  // Atomic owner publication may replace the opened inode during validation.
  // Retry only that explicit race, never permissions, symlinks or malformed JSON.
  for (let attempt = 0; ; attempt++) {
    try {
      return await readAccountStateOnce(root);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "ACCOUNT_STATE_CHANGED" ||
        attempt >= 2
      )
        throw error;
    }
  }
}
async function readAccountStateOnce(
  root: string,
): Promise<LocalLibraryOwner | undefined> {
  if (!isAbsolute(root)) throw new Error("ACCOUNT_STATE_UNSAFE");
  let directory;
  try {
    directory = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("ACCOUNT_STATE_UNSAFE");
  }
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    directory.mode & 0o077
  )
    throw new Error("ACCOUNT_STATE_UNSAFE");
  const path = join(root, STATE_FILE);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("ACCOUNT_STATE_UNSAFE");
  }
  try {
    const before = await file.stat();
    const named = await lstat(path);
    if (
      !named.isSymbolicLink() &&
      (before.ino !== named.ino || before.dev !== named.dev)
    )
      throw new Error("ACCOUNT_STATE_CHANGED");
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.size > 4096 ||
      named.isSymbolicLink() ||
      before.ino !== named.ino ||
      before.dev !== named.dev
    )
      throw new Error("ACCOUNT_STATE_UNSAFE");
    let raw: unknown;
    try {
      raw = JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new Error("ACCOUNT_STATE_INVALID");
    }
    const after = await file.stat();
    const namedAfter = await lstat(path);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      namedAfter.ino !== before.ino ||
      namedAfter.dev !== before.dev ||
      namedAfter.isSymbolicLink()
    )
      throw new Error("ACCOUNT_STATE_CHANGED");
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("ACCOUNT_STATE_INVALID");
    const value = raw as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          !["version", "firebase_uid", "session_generation"].includes(key),
      ) ||
      value.version !== 1
    )
      throw new Error("ACCOUNT_STATE_INVALID");
    if (value.firebase_uid === null && value.session_generation === null)
      return undefined;
    if (
      typeof value.firebase_uid !== "string" ||
      value.firebase_uid.length === 0 ||
      value.firebase_uid.length > 128 ||
      /\p{Cc}/u.test(value.firebase_uid) ||
      typeof value.session_generation !== "string" ||
      !UUID.test(value.session_generation)
    )
      throw new Error("ACCOUNT_STATE_INVALID");
    return {
      uid: value.firebase_uid,
      session_generation: value.session_generation,
    };
  } finally {
    await file.close();
  }
}

function same(
  left: LocalLibraryOwner | undefined,
  right: LocalLibraryOwner | undefined,
): boolean {
  return (
    left?.uid === right?.uid &&
    left?.session_generation === right?.session_generation
  );
}

/** Event-driven account fencing for long native work; commands still perform an authoritative read. */
export class NativeAccountState {
  private watcher: FSWatcher | undefined;
  private owner: LocalLibraryOwner | undefined;
  private valid = false;
  private initialized = false;
  private closed = false;
  private requested = false;
  private reload: Promise<void> | undefined;
  private invalidated:
    ((code: "ACCOUNT_CHANGED" | "ACCOUNT_STATE_UNSAFE") => void) | undefined;
  constructor(private readonly root: string) {}

  async start(
    onInvalidated?: (code: "ACCOUNT_CHANGED" | "ACCOUNT_STATE_UNSAFE") => void,
  ): Promise<LocalLibraryOwner | undefined> {
    if (this.closed) throw new Error("ACCOUNT_STATE_CLOSED");
    if (this.initialized) return this.current();
    this.invalidated = onInvalidated;
    // Verify the directory before installing the watcher; never create a foreign account root.
    await readAccountState(this.root);
    try {
      this.watcher = watch(
        this.root,
        { persistent: false },
        (_event, filename) => {
          if (filename === null || filename === STATE_FILE)
            void this.schedule();
        },
      );
      this.watcher.on("error", () => this.invalidate());
    } catch {
      throw new Error("ACCOUNT_STATE_UNSAFE");
    }
    await this.schedule();
    return this.current();
  }
  current(): LocalLibraryOwner | undefined {
    if (!this.valid || this.closed) throw new Error("ACCOUNT_STATE_UNSAFE");
    return this.owner && { ...this.owner };
  }
  matches(owner?: LocalLibraryOwner): boolean {
    return this.valid && !this.closed && same(this.owner, owner);
  }
  async isCurrent(owner?: LocalLibraryOwner): Promise<boolean> {
    if (this.closed) return false;
    const accepted = owner && { ...owner };
    try {
      const next = await readAccountState(this.root);
      const changed = !this.valid || !same(this.owner, next);
      this.owner = next;
      this.valid = true;
      if (changed && this.initialized) this.notify("ACCOUNT_CHANGED");
      return same(next, accepted);
    } catch {
      this.invalidate();
      return false;
    }
  }
  private invalidate(): void {
    if (this.closed) return;
    const changed = this.valid;
    this.valid = false;
    if (changed && this.initialized) this.notify("ACCOUNT_STATE_UNSAFE");
  }
  private notify(code: "ACCOUNT_CHANGED" | "ACCOUNT_STATE_UNSAFE"): void {
    try {
      void Promise.resolve(this.invalidated?.(code)).catch(() => {});
    } catch {
      /* Cancellation observers cannot damage scope fencing. */
    }
  }
  private schedule(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.requested = true;
    if (this.reload) return this.reload;
    this.reload = (async () => {
      while (this.requested && !this.closed) {
        this.requested = false;
        try {
          const next = await readAccountState(this.root);
          if (this.closed) return;
          const changed = !this.valid || !same(this.owner, next);
          this.owner = next;
          this.valid = true;
          if (changed && this.initialized) this.notify("ACCOUNT_CHANGED");
        } catch {
          this.invalidate();
        }
        this.initialized = true;
      }
    })().finally(() => {
      this.reload = undefined;
      if (this.requested && !this.closed) void this.schedule();
    });
    return this.reload;
  }
  close(): void {
    this.closed = true;
    this.valid = false;
    this.requested = false;
    this.watcher?.close();
    this.watcher = undefined;
  }
  stop(): void {
    this.close();
  }
}
