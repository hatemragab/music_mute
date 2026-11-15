import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, join, posix, relative, sep } from "node:path";

const SITE = "runtime/python/Lib/site-packages/";
export interface WheelFilePin {
  path: string;
  bytes: number;
  sha256: string;
}
interface WheelOwner {
  record: WheelFilePin;
  distribution: string;
  files: Map<string, WheelFilePin>;
}
interface LoaderProfile {
  distribution: string;
  directory: string;
  names?: readonly string[];
  dependencies?: readonly { distribution: string; names: readonly string[] }[];
  absent?: readonly string[];
  bootstrap: readonly WheelFilePin[];
}
// Complete original Windows-wheel source pins: changing a vendor bootstrap
// requires reviewing a new profile, never finding a line in a comment.
const LOADERS: readonly LoaderProfile[] = [
  {
    distribution: "llvmlite",
    directory: "llvmlite.libs",
    bootstrap: [
      {
        path: "llvmlite/__init__.py",
        bytes: 802,
        sha256:
          "3ef22313a4145af60b27199cd325051790ee2f9de3737fb5dca851b4c6bb0054",
      },
    ],
  },
  {
    distribution: "scipy",
    directory: "scipy.libs",
    absent: ["scipy/_distributor_init_local"],
    bootstrap: [
      {
        path: "scipy/__init__.py",
        bytes: 4659,
        sha256:
          "a11ad8a1eaf423d32a0d3dd6c9be6c7be86068321f043dacd2d555a49418b92f",
      },
      {
        path: "scipy/_distributor_init.py",
        bytes: 629,
        sha256:
          "0a6a098851752b233432f9cfa2fea40533bad03e37015958b1f61299a4aea196",
      },
    ],
  },
  {
    distribution: "torch",
    directory: "torch/lib",
    bootstrap: [
      {
        path: "torch/__init__.py",
        bytes: 91447,
        sha256:
          "e55e453e39de6c816498e0dd1d656480d9d0f38a5b1dc56a4875928cc8fb017d",
      },
    ],
  },
  {
    distribution: "numpy",
    directory: "numpy.libs",
    bootstrap: [
      {
        path: "numpy/__init__.py",
        bytes: 26470,
        sha256:
          "a6958cb364663b7acce81ccfd58eeb65a2b34d5376157f924777b97211a73be4",
      },
    ],
  },
  {
    distribution: "ml_dtypes",
    directory: "ml_dtypes.libs",
    bootstrap: [
      {
        path: "ml_dtypes/__init__.py",
        bytes: 4592,
        sha256:
          "4a04f451432a1edd4486a2b6d75de58f98e3b51cf27c86874108fa9a6be7239b",
      },
    ],
  },
  {
    distribution: "onnx_weekly",
    directory: "onnx_weekly.libs",
    bootstrap: [
      {
        path: "onnx/__init__.py",
        bytes: 16227,
        sha256:
          "6e4894b292110b497eaa4c9711c1c339af5fcc12ab64ac1f34b7fffe2d6a5dc5",
      },
    ],
  },
  {
    distribution: "scikit_learn",
    directory: "sklearn/.libs",
    names: ["msvcp140.dll", "vcomp140.dll"],
    bootstrap: [
      {
        path: "sklearn/__init__.py",
        bytes: 4671,
        sha256:
          "4ca68db4b3be340b1ef586b6c6d1cbf394bf1e5c0b2a998f997f02800a50c2c9",
      },
      {
        path: "sklearn/_distributor_init.py",
        bytes: 656,
        sha256:
          "81c3269d5a0d57301c9eb529d74856f91f06ac935d50e9db84dccb8f7e90c70c",
      },
    ],
  },
  {
    distribution: "torch_directml",
    directory: "torch_directml",
    names: ["directml.dll"],
    dependencies: [
      {
        distribution: "torch",
        names: ["c10.dll", "torch_cpu.dll", "torch_python.dll"],
      },
    ],
    bootstrap: [
      {
        path: "torch_directml/__init__.py",
        bytes: 5111,
        sha256:
          "56bf0c24d0f2988268a6435a3d367e0b8757e6e30f1d36007a56b99d943783c6",
      },
      {
        path: "torch/__init__.py",
        bytes: 91447,
        sha256:
          "e55e453e39de6c816498e0dd1d656480d9d0f38a5b1dc56a4875928cc8fb017d",
      },
      {
        path: "torch/_ops.py",
        bytes: 54107,
        sha256:
          "e30a51586164c5464a11db631596812b8c6dd057c6019c9f533b3f005b8bfe98",
      },
      {
        path: "torch/_utils_internal.py",
        bytes: 7563,
        sha256:
          "7d67f7d0e09d87d679874c8ea54023689747d68ce479c3a8a2dd2be5f1c27b1a",
      },
    ],
  },
  {
    distribution: "torchvision",
    directory: "torchvision",
    dependencies: [
      { distribution: "torch", names: ["c10.dll", "torch_cpu.dll"] },
    ],
    bootstrap: [
      {
        path: "torchvision/__init__.py",
        bytes: 3631,
        sha256:
          "cd747a10a42625758c364ba596561b25d4bc22138b36a25a65acf853bec8e1c3",
      },
      {
        path: "torchvision/extension.py",
        bytes: 3233,
        sha256:
          "d00e1e7d0e95f1195070c32d0e92bbe152011e90efe2272392439cf84a243c7c",
      },
      {
        path: "torchvision/_internally_replaced_utils.py",
        bytes: 1439,
        sha256:
          "8e7107d948842900947f506ad9f2133cac7183e67248938d215a2788487c8466",
      },
      {
        path: "torch/__init__.py",
        bytes: 91447,
        sha256:
          "e55e453e39de6c816498e0dd1d656480d9d0f38a5b1dc56a4875928cc8fb017d",
      },
      {
        path: "torch/_ops.py",
        bytes: 54107,
        sha256:
          "e30a51586164c5464a11db631596812b8c6dd057c6019c9f533b3f005b8bfe98",
      },
      {
        path: "torch/_utils_internal.py",
        bytes: 7563,
        sha256:
          "7d67f7d0e09d87d679874c8ea54023689747d68ce479c3a8a2dd2be5f1c27b1a",
      },
    ],
  },
];
export interface WheelDllProof {
  record: WheelFilePin;
  bootstrap: WheelFilePin[];
  bootstrapRecords: WheelFilePin[];
}
function invalid(): never {
  throw new TypeError(
    "Consumer Python wheel ownership/bootstrap proof is invalid",
  );
}
function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    ended = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          ended = true;
        }
      } else {
        if (c === "\r" || c === "\n") invalid();
        field += c;
      }
    } else if (c === '"') {
      if (field || ended) invalid();
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      ended = false;
      if (c !== ",") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (row.length !== 3 || rows.length >= 32768) invalid();
        rows.push(row);
        row = [];
      }
    } else {
      if (ended || c.charCodeAt(0) < 32) invalid();
      field += c;
    }
    if (field.length > 2048 || row.length > 2) invalid();
  }
  if (quoted) invalid();
  if (field || ended || row.length) {
    row.push(field);
    if (row.length !== 3 || rows.length >= 32768) invalid();
    rows.push(row);
  }
  return rows;
}
function recordPath(value: string): string {
  if (
    !value ||
    value.length > 1024 ||
    /[\\:]/u.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    value.startsWith("/") ||
    value.split("/").some((p) => !p || p === ".")
  )
    invalid();
  const path = posix.normalize(posix.join(SITE, value));
  if (!path.startsWith("runtime/python/") || path === "runtime/python/")
    invalid();
  return path;
}
async function pinned(
  root: string,
  path: string,
  max: number,
  contents?: (chunk: Buffer) => void,
): Promise<WheelFilePin> {
  const absolute = join(root, ...path.split("/"));
  const named = await lstat(absolute);
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1 ||
    named.size < 1 ||
    named.size > max
  )
    invalid();
  const handle = await open(absolute, "r");
  try {
    const before = await handle.stat();
    const same = (a: typeof before, b: typeof before) =>
      a.isFile() &&
      !a.isSymbolicLink() &&
      a.nlink === 1 &&
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs;
    if (!same(before, named)) invalid();
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > before.size) invalid();
      hash.update(chunk);
      contents?.(chunk);
    }
    if (
      bytes !== before.size ||
      !same(await handle.stat(), before) ||
      !same(await lstat(absolute), before)
    )
      invalid();
    return { path, bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}
export class WindowsPythonWheels {
  private readonly owners = new Map<string, WheelOwner[]>();
  private readonly verified = new Set<string>();
  private readonly bootstrap = new Map<string, WheelDllProof>();
  private constructor(
    private readonly root: string,
    private readonly inventory: Set<string>,
  ) {}
  static async read(
    root: string,
    files: readonly string[],
  ): Promise<WindowsPythonWheels> {
    const inventory = new Set(
      files.map((p) => relative(root, p).split(sep).join("/")),
    );
    const result = new WindowsPythonWheels(root, inventory);
    const records = [...inventory].filter((p) =>
      /^runtime\/python\/Lib\/site-packages\/[A-Za-z0-9_.]+-[A-Za-z0-9_.+]+\.dist-info\/RECORD$/u.test(
        p,
      ),
    );
    if (records.length > 256) invalid();
    let total = 0;
    for (const path of records) {
      const chunks: Buffer[] = [];
      const before = await pinned(root, path, 4 * 1024 * 1024, (chunk) =>
        chunks.push(chunk),
      );
      total += before.bytes;
      if (total > 32 * 1024 * 1024) invalid();
      const bytes = Buffer.concat(chunks);
      const owner: WheelOwner = {
        record: before,
        distribution: path.slice(SITE.length).split("-")[0]!,
        files: new Map(),
      };
      const seen = new Set<string>();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        invalid();
      }
      for (const [name, digest, size] of csv(text)) {
        const key = recordPath(name!);
        if (seen.has(key.toLowerCase())) invalid();
        seen.add(key.toLowerCase());
        if (!digest && !size) continue;
        if (
          !/^sha256=[A-Za-z0-9_-]{43}$/u.test(digest!) ||
          !/^(?:0|[1-9][0-9]{0,9})$/u.test(size!)
        )
          invalid();
        const sha = Buffer.from(digest!.slice(7), "base64url");
        if (sha.length !== 32 || sha.toString("base64url") !== digest!.slice(7))
          invalid();
        const entry = {
          path: key,
          bytes: Number(size),
          sha256: sha.toString("hex"),
        };
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes > 2 ** 31)
          invalid();
        owner.files.set(key, entry);
        const owners = result.owners.get(key.toLowerCase()) ?? [];
        owners.push(owner);
        result.owners.set(key.toLowerCase(), owners);
      }
    }
    return result;
  }
  private owner(path: string): WheelOwner | undefined {
    const owners = this.owners.get(path.toLowerCase()) ?? [];
    if (owners.length > 1) invalid();
    return owners[0];
  }
  private async verify(owner: WheelOwner, path: string): Promise<WheelFilePin> {
    const expected = owner.files.get(path);
    if (!expected || !this.inventory.has(path)) invalid();
    if (!this.verified.has(path)) {
      const actual = await pinned(this.root, path, 512 * 1024 * 1024);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
        invalid();
      this.verified.add(path);
    }
    return expected;
  }
  async ownership(path: string, record: WheelFilePin): Promise<void> {
    const owner = this.owner(path);
    if (
      !owner ||
      owner.record.path !== record.path ||
      owner.record.bytes !== record.bytes ||
      owner.record.sha256 !== record.sha256
    )
      invalid();
    await this.verify(owner, path);
  }
  async adjacent(binary: string, dependency: string): Promise<void> {
    const owner = this.owner(binary),
      other = this.owner(dependency);
    if (!owner && !other) return;
    if (!owner || owner !== other) invalid();
    await this.verify(owner, binary);
    await this.verify(owner, dependency);
  }
  private async loader(
    owner: WheelOwner,
    profile: LoaderProfile,
  ): Promise<WheelDllProof> {
    let proof = this.bootstrap.get(owner.record.path);
    if (proof) return proof;
    for (const absent of profile.absent ?? [])
      if (
        [...this.inventory].some(
          (path) =>
            path
              .toLowerCase()
              .startsWith((SITE + absent + ".").toLowerCase()) ||
            path.toLowerCase().startsWith((SITE + absent + "/").toLowerCase()),
        )
      )
        invalid();
    const bootstrap: WheelFilePin[] = [],
      records = new Map<string, WheelFilePin>();
    for (const expected of profile.bootstrap) {
      const path = SITE + expected.path,
        source = this.owner(path);
      if (
        !source ||
        (source !== owner &&
          !profile.dependencies?.some(
            (dependency) => dependency.distribution === source.distribution,
          ))
      )
        invalid();
      const actual = await this.verify(source, path);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
        invalid();
      bootstrap.push(actual);
      records.set(source.record.path, source.record);
    }
    // WinDLL/CDLL with an explicit path must have that exact owned file;
    // an executable-directory or another wheel's copy cannot substitute it.
    for (const name of profile.names ?? []) {
      const candidates = [...this.inventory].filter(
        (path) =>
          dirname(path) === SITE + profile.directory &&
          basename(path).toLowerCase() === name &&
          this.owner(path) === owner,
      );
      if (candidates.length !== 1) invalid();
      await this.verify(owner, candidates[0]!);
    }
    proof = {
      record: owner.record,
      bootstrap,
      bootstrapRecords: [...records.values()],
    };
    this.bootstrap.set(owner.record.path, proof);
    return proof;
  }
  async audit(binary: string): Promise<void> {
    const owner = this.owner(binary);
    if (!owner) return;
    const profile = LOADERS.find(
      (profile) => profile.distribution === owner.distribution,
    );
    if (!profile) return;
    await this.loader(owner, profile);
    await this.verify(owner, binary);
  }
  async resolve(
    binary: string,
    name: string,
    candidates: readonly string[],
  ): Promise<{ paths: string[]; proof?: WheelDllProof }> {
    const owner = this.owner(binary);
    if (!owner) return { paths: [] };
    const profile = LOADERS.find((p) => p.distribution === owner.distribution);
    const dependency = profile?.dependencies?.find((dependency) =>
      dependency.names.includes(name),
    );
    if (
      !profile ||
      (profile.names && !profile.names.includes(name) && !dependency)
    )
      return { paths: [] };
    const proof = await this.loader(owner, profile);
    await this.verify(owner, binary);
    const targetProfile = dependency
      ? LOADERS.find(
          (profile) => profile.distribution === dependency.distribution,
        )
      : profile;
    if (!targetProfile) invalid();
    const targetOwner = dependency
      ? this.owner(SITE + targetProfile.bootstrap[0]!.path)
      : owner;
    if (
      !targetOwner ||
      (dependency && targetOwner.distribution !== dependency.distribution)
    )
      invalid();
    if (dependency) await this.loader(targetOwner, targetProfile);
    const selected = candidates.filter(
      (p) =>
        dirname(p) === SITE + targetProfile.directory &&
        this.owner(p) === targetOwner,
    );
    const expected = [...targetOwner.files.values()].filter(
      (file) =>
        dirname(file.path) === SITE + targetProfile.directory &&
        basename(file.path).toLowerCase() === name,
    );
    if ((dependency || expected.length) && selected.length !== 1) invalid();
    for (const path of selected) await this.verify(targetOwner, path);
    return { paths: selected, proof };
  }
}
