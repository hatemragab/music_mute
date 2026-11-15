import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { lstatSync } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBackendLogsServer } from "./server.js";

// This entrypoint is built to tools/logs-mcp/dist/src/index.js.
// Locate the capture from the workspace, independent of the AI host's cwd.
export const workspaceRoot = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
/** Select once during host startup; never switch the backing capture mid-connection. */
export function selectDefaultCaptureFile(root = workspaceRoot): string {
  const unified = resolve(root, ".runtime/local-logging/events.jsonl");
  try {
    const parent = dirname(unified);
    let current = parse(parent).root;
    for (const part of relative(current, parent).split(sep).filter(Boolean)) {
      current = join(current, part);
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Unsafe capture.");
    }
    const info = lstatSync(unified);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (info.mode & 0o444) === 0
    ) {
      throw new Error("Unsafe capture.");
    }
    return unified;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Local capture cannot be selected safely.");
    return resolve(root, ".runtime/local-logging/events.jsonl");
  }
}

// Preserve the exported legacy fallback path. Selection happens inside main's
// error boundary, so --file and --help never inspect an unrelated default path.
export const defaultCaptureFile = resolve(
  workspaceRoot,
  ".runtime/local-logging/events.jsonl",
);

export function parseArguments(
  args: readonly string[],
  root = workspaceRoot,
): { help: boolean; file: string } {
  if (args.length === 0) {
    return {
      help: false,
      file: process.env.MUSICMUTE_LOG_CAPTURE
        ? resolve(process.env.MUSICMUTE_LOG_CAPTURE)
        : selectDefaultCaptureFile(root),
    };
  }
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    return {
      help: true,
      file: resolve(root, ".runtime/local-logging/events.jsonl"),
    };
  }
  throw new Error("Use musicmute-logs-mcp [--help].");
}

export function main(args = process.argv.slice(2)): void {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write(
      "Usage: node tools/logs-mcp/dist/src/index.js [--help]\n" +
        "Read-only MCP over stdio: search_logs, trace_request, error_summary, trace_events, list_log_archives.\n" +
        "Uses MUSICMUTE_LOG_CAPTURE or .runtime/local-logging/events.jsonl; selection is fixed at startup.\n" +
        "Tool arguments accept only exact fixed-name sibling archive IDs, never file paths.\n" +
        "The AI host starts this process; it never starts the API or viewer.\n",
    );
    return;
  }
  const handle = serveStdio(() => createBackendLogsServer(options.file), {
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 256 * 1024,
    }),
    onerror: () => {
      process.stderr.write("Backend log MCP transport error.\n");
    },
  });
  const stop = () => {
    void handle.close().catch(() => {
      process.stderr.write("Backend log MCP shutdown failed.\n");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch {
    process.stderr.write(
      "Could not start backend log MCP. Check the command and local installation.\n",
    );
    process.exitCode = 1;
  }
}
