import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createWriteStream, WriteStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { packageFile } from "../validate-assets.js";

const TOKEN = Symbol("store-asar-writer"),
  DENIED = "STORE_GUI_ASAR_WRITER_DENIED";
const FILES = Object.freeze([
  {
    name: "asar.js",
    bytes: 13658,
    sha256: "91e89e96324626b140f3e897dffaca6e3cbb1135c4192ce6ceaa0e84af4ba152",
  },
  {
    name: "disk.js",
    bytes: 9850,
    sha256: "849ea3eebaf945978a48ae1f08d429d235430f4f8cc94486d124755a7fa379bb",
  },
  {
    name: "wrapped-fs.js",
    bytes: 777,
    sha256: "601c3c2151986f62de3b7297e3630873a6924230852c7f36c0b172cdabf0a4de",
  },
]);
const FUNCTION_SHA256 =
  "5b7ef9b0698195703a4a037e8218081a0108bdfde8725655c42f0f29a2acd4ed";
type AsarApi = typeof import("@electron/asar");
type WrappedFs = { createWriteStream: typeof createWriteStream };
type Pin = {
  path: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  nlink: bigint;
  birthtimeNs: bigint;
  mtimeNs: bigint;
  sha256: string;
};
function deny(): never {
  throw new Error(DENIED);
}
function hash(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function canonicalDirectory(value: string) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    (await realpath(value)) !== value
  )
    deny();
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink()) deny();
  return value;
}
async function pinFile(
  path: string,
  expected: (typeof FILES)[number],
): Promise<Pin> {
  const before = await lstat(path, { bigint: true });
  const bytes = await packageFile(path, 1024 * 1024),
    after = await lstat(path, { bigint: true });
  if (
    bytes.length !== expected.bytes ||
    hash(bytes) !== expected.sha256 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.nlink !== after.nlink ||
    before.birthtimeNs !== after.birthtimeNs ||
    before.mtimeNs !== after.mtimeNs
  )
    deny();
  return {
    path,
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    nlink: after.nlink,
    birthtimeNs: after.birthtimeNs,
    mtimeNs: after.mtimeNs,
    sha256: expected.sha256,
  };
}

/** Build-side compatibility only. It grants no Store, signing, launch or Ready
 * authority. The producer's dedicated owned Node process is the only caller. */
export class StoreAsarWriterJoin {
  static #active: StoreAsarWriterJoin | undefined;
  #api: AsarApi;
  #fs: WrappedFs;
  #original: AsarApi["createPackageFromStreams"];
  #originalStream: typeof createWriteStream;
  #wrapper: AsarApi["createPackageFromStreams"];
  #streamWrapper: typeof createWriteStream;
  #pins: readonly Pin[];
  #output: string;
  #writer: WriteStream | undefined;
  #pending: Promise<WriteStream> | undefined;
  #joined: Promise<void> | undefined;
  #called = false;
  #completed = false;
  #closing: Promise<void> | undefined;
  private constructor(
    token: symbol,
    api: AsarApi,
    fs: WrappedFs,
    pins: readonly Pin[],
    output: string,
  ) {
    if (token !== TOKEN || StoreAsarWriterJoin.#active) deny();
    this.#api = api;
    this.#fs = fs;
    this.#original = api.createPackageFromStreams;
    this.#originalStream = fs.createWriteStream;
    this.#pins = pins;
    this.#output = output;
    this.#streamWrapper = ((
      path: Parameters<typeof createWriteStream>[0],
      options?: Parameters<typeof createWriteStream>[1],
    ) => {
      if (
        !this.#called ||
        this.#closing ||
        this.#writer ||
        path !== this.#output ||
        options !== undefined
      )
        deny();
      // The package is an exclusively created candidate; even an unexpected
      // same-name output cannot be truncated by the dependency's default "w".
      const writer = this.#originalStream(path, { flags: "wx" });
      if (!(writer instanceof WriteStream) || writer.path !== this.#output) {
        writer.destroy();
        deny();
      }
      this.#writer = writer;
      this.#joined = finished(writer, { cleanup: true });
      void this.#joined.catch(() => {}); // Retain and observe, never discard.
      return writer;
    }) as typeof createWriteStream;
    this.#wrapper = async (output, streams) => {
      if (
        this.#called ||
        this.#closing ||
        output !== this.#output ||
        !Array.isArray(streams) ||
        streams.length < 1
      )
        deny();
      this.#called = true;
      this.#pending = this.#original(output, streams);
      void this.#pending.catch(() => {});
      const writer = await this.#pending;
      if (writer !== this.#writer || !this.#joined) deny();
      await this.#joined;
      if (!writer.closed || !writer.writableFinished) deny();
      await this.#revalidate();
      this.#completed = true;
      return writer;
    };
    StoreAsarWriterJoin.#active = this;
    api.createPackageFromStreams = this.#wrapper;
    fs.createWriteStream = this.#streamWrapper;
    Object.freeze(this);
  }
  static async open(
    componentRoot: string,
    stageRoot: string,
  ): Promise<StoreAsarWriterJoin> {
    if (
      arguments.length !== 2 ||
      StoreAsarWriterJoin.#active ||
      "electron" in process.versions
    )
      deny();
    await canonicalDirectory(componentRoot);
    await canonicalDirectory(stageRoot);
    const loader = createRequire(join(componentRoot, "package.json"));
    const builderPackage = loader.resolve("app-builder-lib/package.json");
    if (
      JSON.parse((await packageFile(builderPackage, 65536)).toString("utf8"))
        .version !== "26.15.3"
    )
      deny();
    const builderLoader = createRequire(builderPackage),
      asarPath = builderLoader.resolve("@electron/asar"),
      moduleRoot = dirname(dirname(asarPath));
    const within = relative(join(componentRoot, "node_modules"), moduleRoot);
    if (
      !within ||
      within === ".." ||
      within.startsWith(".." + sep) ||
      isAbsolute(within) ||
      (await realpath(asarPath)) !== asarPath
    )
      deny();
    if (
      JSON.parse(
        (await packageFile(join(moduleRoot, "package.json"), 65536)).toString(
          "utf8",
        ),
      ).version !== "3.4.1" ||
      loader.resolve("@electron/asar") !== asarPath
    )
      deny();
    const pins = await Promise.all(
      FILES.map((entry) => pinFile(join(moduleRoot, "lib", entry.name), entry)),
    );
    const api = builderLoader("@electron/asar") as AsarApi,
      fs = builderLoader(join(moduleRoot, "lib/wrapped-fs.js"))
        .default as WrappedFs;
    const descriptor = Object.getOwnPropertyDescriptor(
        api,
        "createPackageFromStreams",
      ),
      streamDescriptor = Object.getOwnPropertyDescriptor(
        fs,
        "createWriteStream",
      );
    if (
      !descriptor?.writable ||
      !streamDescriptor?.writable ||
      typeof api.createPackageFromStreams !== "function" ||
      hash(api.createPackageFromStreams.toString().replaceAll("\r\n", "\n")) !==
        FUNCTION_SHA256 ||
      fs.createWriteStream !== createWriteStream
    )
      deny();
    const output = join(
      stageRoot,
      "electron-output",
      "win-unpacked",
      "resources",
      "app.asar",
    );
    const result = new StoreAsarWriterJoin(TOKEN, api, fs, pins, output);
    try {
      // The pinned builder uses this exact native import() namespace. A cached
      // earlier namespace or another wrapper cannot silently bypass the join.
      const namespace = (await import(pathToFileURL(asarPath).href)) as AsarApi;
      if (namespace.createPackageFromStreams !== result.#wrapper) deny();
      return result;
    } catch (error) {
      await result.close();
      throw error;
    }
  }
  async #revalidate() {
    for (const pin of this.#pins) {
      const info = await lstat(pin.path, { bigint: true });
      if (
        info.dev !== pin.dev ||
        info.ino !== pin.ino ||
        info.size !== pin.size ||
        info.nlink !== pin.nlink ||
        info.birthtimeNs !== pin.birthtimeNs ||
        info.mtimeNs !== pin.mtimeNs ||
        hash(await packageFile(pin.path, 1024 * 1024)) !== pin.sha256
      )
        deny();
    }
  }
  async assertCompleted(): Promise<void> {
    if (
      arguments.length !== 0 ||
      this.#closing ||
      !this.#called ||
      !this.#completed ||
      !this.#writer?.closed ||
      !this.#writer.writableFinished
    )
      deny();
    await this.#revalidate();
  }
  close(): Promise<void> {
    if (arguments.length !== 0) return Promise.reject(new Error(DENIED));
    return (this.#closing ??= this.#close());
  }
  async #close() {
    try {
      // Join the bounded source-file enumeration first. Destroying its output
      // while an input is piping can pause that input before its end event.
      await this.#pending?.catch(() => {});
      if (this.#writer && !this.#writer.closed) {
        const writer = this.#writer;
        const closed = new Promise<void>((resolve) =>
          writer.once("close", resolve),
        );
        writer.destroy();
        await closed;
      }
      await this.#joined?.catch(() => {});
      await this.#revalidate();
    } finally {
      const intact =
        this.#api.createPackageFromStreams === this.#wrapper &&
        this.#fs.createWriteStream === this.#streamWrapper;
      // Restore only our exact wrappers. Never overwrite another actor's edit.
      if (this.#api.createPackageFromStreams === this.#wrapper)
        this.#api.createPackageFromStreams = this.#original;
      if (this.#fs.createWriteStream === this.#streamWrapper)
        this.#fs.createWriteStream = this.#originalStream;
      if (StoreAsarWriterJoin.#active === this)
        StoreAsarWriterJoin.#active = undefined;
      if (!intact) deny();
    }
  }
}
