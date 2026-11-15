const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { readFile } = require("node:fs/promises");
const run = promisify(execFile);
async function authenticodeInvocation(
  artifact,
  publisher,
  kind,
  asarHeaderSha256,
) {
  if (
    !path.isAbsolute(artifact) ||
    !/^[a-f0-9]{64}$/.test(publisher) ||
    !["payload", "installer"].includes(kind) ||
    (asarHeaderSha256 !== undefined && !/^[a-f0-9]{64}$/.test(asarHeaderSha256))
  )
    throw new Error("PACKAGE_SIGNATURE_INVALID");
  // Only reviewed static source becomes code. Every caller value is environment
  // data; paths containing quotes, dollars or semicolons cannot become commands.
  const script = await readFile(
    path.join(__dirname, "audit-authenticode.ps1"),
    "utf8",
  );
  const environment = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
  ])
    if (typeof process.env[name] === "string")
      environment[name] = process.env[name];
  if (environment.SystemRoot)
    environment.PATH = path.join(environment.SystemRoot, "System32");
  return {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    env: {
      ...environment,
      MUSICMUTE_AUDIT_ARTIFACT: artifact,
      MUSICMUTE_AUDIT_PUBLISHER: publisher,
      MUSICMUTE_AUDIT_KIND: kind,
      MUSICMUTE_AUDIT_ASAR: asarHeaderSha256 ?? "",
    },
  };
}
async function verifySignedPe(
  artifact,
  publisher,
  kind = "payload",
  asarHeaderSha256,
) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("WINDOWS_PACKAGE_MACHINE_REQUIRED");
  const { args, env } = await authenticodeInvocation(
    artifact,
    publisher,
    kind,
    asarHeaderSha256,
  );
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot))
    throw new Error("WINDOWS_PACKAGE_MACHINE_REQUIRED");
  try {
    const reply = await run(
      path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args,
      { env, timeout: 60000, windowsHide: true, maxBuffer: 65536 },
    );
    if (reply.stdout !== '{"verified":true}' || reply.stderr)
      throw new Error("PACKAGE_SIGNATURE_INVALID");
  } catch {
    throw new Error("PACKAGE_SIGNATURE_INVALID");
  }
}
module.exports = { verifySignedPe, authenticodeInvocation };
