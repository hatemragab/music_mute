import { spawn } from "node:child_process";

const DEDICATED_ACCOUNT = "_musicmute";
const MIN_SERVICE_ID = 200;
const MAX_SERVICE_ID = 499;

type CommandResult = Readonly<{
  code: number;
  stdout: string;
}>;

export type MacAccountCommand = (
  executable: string,
  arguments_: readonly string[],
) => Promise<CommandResult>;

export type MacServiceOwner = Readonly<{
  uid: number;
  gid: number;
}>;

export type EnsuredMacServiceAccount = Readonly<{
  owner: MacServiceOwner;
  created: boolean;
}>;

export async function ensureMacServiceAccount(
  serviceUser: string,
  serviceGroup: string,
  run: MacAccountCommand = runCommand,
): Promise<EnsuredMacServiceAccount> {
  const userExists = await recordExists("/Users", serviceUser, run);
  const groupExists = await recordExists("/Groups", serviceGroup, run);
  if (userExists !== groupExists)
    throw new TypeError("macOS service account state is incomplete");
  if (userExists)
    return {
      owner: await readMacServiceOwner(serviceUser, serviceGroup, run),
      created: false,
    };
  if (serviceUser !== DEDICATED_ACCOUNT || serviceGroup !== DEDICATED_ACCOUNT)
    throw new TypeError(
      "macOS automatic account creation is restricted to _musicmute",
    );
  const serviceId = await findAvailableServiceId(run);
  let groupCreated = false;
  let userCreated = false;
  try {
    await requiredCommand(run, "/usr/bin/dscl", [
      ".",
      "-create",
      `/Groups/${serviceGroup}`,
    ]);
    groupCreated = true;
    await requiredCommand(run, "/usr/bin/dscl", [
      ".",
      "-create",
      `/Groups/${serviceGroup}`,
      "PrimaryGroupID",
      String(serviceId),
    ]);
    await requiredCommand(run, "/usr/bin/dscl", [
      ".",
      "-create",
      `/Groups/${serviceGroup}`,
      "RealName",
      "MusicMute Worker",
    ]);
    await requiredCommand(run, "/usr/bin/dscl", [
      ".",
      "-create",
      `/Users/${serviceUser}`,
    ]);
    userCreated = true;
    for (const [property, value] of [
      ["UniqueID", String(serviceId)],
      ["PrimaryGroupID", String(serviceId)],
      ["NFSHomeDirectory", "/var/empty"],
      ["UserShell", "/usr/bin/false"],
      ["RealName", "MusicMute Worker"],
      ["IsHidden", "1"],
      ["Password", "*"],
    ] as const)
      await requiredCommand(run, "/usr/bin/dscl", [
        ".",
        "-create",
        `/Users/${serviceUser}`,
        property,
        value,
      ]);
    const owner = await readMacServiceOwner(serviceUser, serviceGroup, run);
    if (owner.uid !== serviceId || owner.gid !== serviceId)
      throw new TypeError("macOS service account verification failed");
    return { owner, created: true };
  } catch (error) {
    if (userCreated)
      await bestEffortDelete(run, "/Users", serviceUser, serviceId);
    if (groupCreated)
      await bestEffortDelete(run, "/Groups", serviceGroup, serviceId);
    throw error;
  }
}

export async function readMacServiceOwner(
  serviceUser: string,
  serviceGroup: string,
  run: MacAccountCommand = runCommand,
): Promise<MacServiceOwner> {
  const primaryGroup = await accountValue(run, "-gn", serviceUser);
  if (primaryGroup !== serviceGroup)
    throw new TypeError(
      "macOS service group must be the account primary group",
    );
  return {
    uid: await accountId(run, "-u", serviceUser),
    gid: await accountId(run, "-g", serviceUser),
  };
}

async function recordExists(
  root: "/Users" | "/Groups",
  name: string,
  run: MacAccountCommand,
): Promise<boolean> {
  const result = await run("/usr/bin/dscl", [".", "-read", `${root}/${name}`]);
  return result.code === 0;
}

async function findAvailableServiceId(run: MacAccountCommand): Promise<number> {
  const used = new Set<number>();
  for (const [root, property] of [
    ["/Users", "UniqueID"],
    ["/Groups", "PrimaryGroupID"],
  ] as const) {
    const result = await run("/usr/bin/dscl", [".", "-list", root, property]);
    if (result.code !== 0)
      throw new TypeError("macOS service account IDs cannot be inspected");
    for (const line of result.stdout.split(/\r?\n/u)) {
      const match = /\s(\d+)\s*$/u.exec(line);
      if (match?.[1] !== undefined) used.add(Number(match[1]));
    }
  }
  for (let candidate = MAX_SERVICE_ID; candidate >= MIN_SERVICE_ID; candidate--)
    if (!used.has(candidate)) return candidate;
  throw new TypeError("macOS service account ID range is exhausted");
}

async function deleteMatchingRecord(
  run: MacAccountCommand,
  root: "/Users" | "/Groups",
  name: string,
  expectedId: number,
  property: "UniqueID" | "PrimaryGroupID",
): Promise<void> {
  const result = await run("/usr/bin/dscl", [
    ".",
    "-read",
    `${root}/${name}`,
    property,
  ]);
  if (result.code !== 0) return;
  const match = /:\s*(\d+)\s*$/u.exec(result.stdout);
  if (match?.[1] === undefined || Number(match[1]) !== expectedId)
    throw new TypeError("macOS service account rollback identity changed");
  await requiredCommand(run, "/usr/bin/dscl", [
    ".",
    "-delete",
    `${root}/${name}`,
  ]);
}

async function bestEffortDelete(
  run: MacAccountCommand,
  root: "/Users" | "/Groups",
  name: string,
  expectedId: number,
): Promise<void> {
  try {
    await deleteMatchingRecord(
      run,
      root,
      name,
      expectedId,
      root === "/Users" ? "UniqueID" : "PrimaryGroupID",
    );
  } catch {
    // Preserve the original installation error. A later repair reports leftovers.
  }
}

async function accountId(
  run: MacAccountCommand,
  flag: "-u" | "-g",
  name: string,
): Promise<number> {
  const id = Number(await accountValue(run, flag, name));
  if (!Number.isSafeInteger(id) || id < 0)
    throw new TypeError("macOS service account ID is invalid");
  return id;
}

async function accountValue(
  run: MacAccountCommand,
  flag: "-u" | "-g" | "-gn",
  name: string,
): Promise<string> {
  const result = await run("/usr/bin/id", [flag, name]);
  if (result.code !== 0)
    throw new TypeError("macOS service account does not exist");
  return result.stdout.trim();
}

async function requiredCommand(
  run: MacAccountCommand,
  executable: string,
  arguments_: readonly string[],
): Promise<void> {
  const result = await run(executable, arguments_);
  if (result.code !== 0)
    throw new TypeError("macOS service account command failed");
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 65_536) stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolvePromise({ code: signal === null ? (code ?? 1) : 1, stdout });
    });
  });
}
