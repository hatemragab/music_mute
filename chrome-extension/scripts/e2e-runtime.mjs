import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Read an explicitly selected runtime or the Mac app's validated active release. */
export async function resolveE2ERuntime({
  environment = process.env,
  userHome = homedir(),
  resolvePackagedRuntime,
} = {}) {
  const explicit = environment.MUSICMUTE_LOCAL_RUNTIME;
  if (
    explicit !== undefined &&
    (typeof explicit !== "string" || !isAbsolute(explicit))
  )
    throw new Error("E2E_RUNTIME_PATH_INVALID");
  try {
    const selected =
      explicit ??
      (
        await resolvePackagedRuntime(
          "/Applications/MusicMute Local.app/Contents/Resources",
          join(userHome, "Library/Application Support/MusicMuteLocal"),
        )
      ).runtime_root;
    if (typeof selected !== "string" || !isAbsolute(selected))
      throw new Error("E2E_RUNTIME_EXECUTABLE_MISSING");
    const runtime = await realpath(selected);
    const node = join(runtime, "runtime/node/bin/node");
    const python = join(runtime, "runtime/python/bin/python3");
    await Promise.all(
      [node, python].map(async (path) => {
        await access(path, constants.X_OK);
        if (!(await stat(path)).isFile())
          throw new Error("E2E_RUNTIME_EXECUTABLE_MISSING");
      }),
    );
    return { runtime, node, python };
  } catch {
    // Do not expose user paths or inspect unrelated worker/account state.
    throw new Error("E2E_RUNTIME_EXECUTABLE_MISSING");
  }
}
