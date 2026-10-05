import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const QUALIFICATION_DIRECTORY =
  /^qualification-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ATTEMPT_DIRECTORY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Call only after a successful durable enrollment report or activation. */
export async function cleanupQualificationWorkspace(options: {
  workRoot: string;
  outputPath: string;
}): Promise<boolean> {
  if (!isAbsolute(options.workRoot) || !isAbsolute(options.outputPath))
    throw new TypeError("Qualification cleanup paths must be absolute");
  const root = resolve(options.workRoot);
  const parts = relative(root, resolve(options.outputPath)).split(sep);
  if (
    !QUALIFICATION_DIRECTORY.test(parts[0] ?? "") ||
    !(
      (parts.length === 2 && parts[1] === "vocals.mp3") ||
      (parts.length === 4 &&
        ATTEMPT_DIRECTORY.test(parts[1] ?? "") &&
        parts[2] === "output" &&
        parts[3] === "vocals.mp3")
    )
  )
    return false;
  const workspace = join(root, parts[0]!);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new TypeError("Qualification work root is unsafe");
    if ((await realpath(workspace)) !== join(await realpath(root), parts[0]!))
      throw new TypeError("Qualification workspace contains a symbolic link");
    await assertSafeTree(workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await rm(workspace, { recursive: true, force: true });
  return true;
}

async function assertSafeTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
    throw new TypeError("Qualification workspace contains an unsafe entry");
  if (info.isDirectory())
    for (const name of await readdir(path))
      await assertSafeTree(join(path, name));
}
