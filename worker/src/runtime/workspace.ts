import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXTENSIONS: Record<string, string> = {
  "audio/flac": ".flac",
  "audio/m4a": ".m4a",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-m4a": ".m4a",
  "audio/x-wav": ".wav",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

export interface AttemptWorkspace {
  root: string;
  input: string;
  output: string;
}

export class WorkspaceManager {
  private root = "";

  constructor(private readonly configuredRoot: string) {
    if (!isAbsolute(configuredRoot))
      throw new TypeError("Worker workspace root must be absolute");
  }

  async initialize(): Promise<void> {
    await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
    const information = await lstat(this.configuredRoot);
    if (!information.isDirectory() || information.isSymbolicLink())
      throw new TypeError("Worker workspace root is unsafe");
    this.root = await realpath(this.configuredRoot);
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!UUID_V4.test(entry.name)) continue;
      const target = this.childPath(entry.name);
      const targetInfo = await lstat(target);
      if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())
        throw new TypeError(
          "Worker workspace contains an unsafe attempt entry",
        );
      await rm(target, { recursive: true, force: true });
    }
  }

  async create(
    attemptId: string,
    contentType: string,
  ): Promise<AttemptWorkspace> {
    this.assertInitialized();
    if (!UUID_V4.test(attemptId)) throw new TypeError("Attempt ID is invalid");
    const root = this.childPath(attemptId);
    await mkdir(root, { recursive: false, mode: 0o700 });
    const extension = EXTENSIONS[contentType.toLowerCase()] ?? ".bin";
    return {
      root,
      input: join(root, `input${extension}`),
      output: join(root, "output", "vocals.mp3"),
    };
  }

  async cleanup(workspace: AttemptWorkspace): Promise<void> {
    this.assertInitialized();
    const target = resolve(workspace.root);
    const name = basename(target);
    if (!UUID_V4.test(name) || target !== this.childPath(name))
      throw new TypeError("Attempt workspace escaped the configured root");
    const information = await lstat(target).catch(() => null);
    if (
      information &&
      (!information.isDirectory() || information.isSymbolicLink())
    )
      throw new TypeError("Attempt workspace became unsafe");
    await rm(target, { recursive: true, force: true });
  }

  private childPath(name: string): string {
    const target = resolve(this.root || this.configuredRoot, name);
    const base = resolve(this.root || this.configuredRoot);
    if (!target.startsWith(`${base}${sep}`))
      throw new TypeError("Worker workspace path escaped its root");
    return target;
  }

  private assertInitialized(): void {
    if (!this.root) throw new Error("Worker workspace is not initialized");
  }
}
