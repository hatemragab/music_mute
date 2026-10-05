import type { MacosUploadGrant } from "./macos-updates-api";

export const MAX_DMG_BYTES = 2 * 1024 ** 3;
export const MAX_APPCAST_BYTES = 32 * 1024;
const sparkleNamespace = "http://www.andymatuschak.org/xml-namespaces/sparkle";
const archivePattern =
  /^MusicMute-(\d+\.\d+\.\d+(?:\.\d+)?)-([1-9]\d{0,17})-arm64-([a-f0-9]{64})\.dmg$/;

export const validPublicEdKey = (value: string) => {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try {
    return atob(value).length === 32 && btoa(atob(value)) === value;
  } catch {
    return false;
  }
};

export const validateDmg = (file: File) => {
  if (!archivePattern.test(file.name) || file.name.length > 256)
    throw new Error(
      "Select the canonical MusicMute DMG from update preparation.",
    );
  if (file.size <= 0) throw new Error("The DMG is empty.");
  if (file.size > MAX_DMG_BYTES)
    throw new Error("The DMG exceeds the 2 GiB limit.");
};

export async function readSignedAppcast(
  file: File,
  archive: File,
  downloadBaseUrl: string,
) {
  validateDmg(archive);
  if (
    file.name !== "appcast.xml" ||
    file.size < 1 ||
    file.size > MAX_APPCAST_BYTES
  )
    throw new Error("Select the signed appcast.xml (at most 32 KiB).");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size || bytes.length > MAX_APPCAST_BYTES)
    throw new Error("The appcast size changed while reading.");
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The appcast must contain valid UTF-8.");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("The appcast cannot contain entity declarations.");
  if (!/<!-- sparkle-signatures:\n/.test(xml))
    throw new Error("The appcast must be signed during update preparation.");
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  const items = parsed.getElementsByTagName("item");
  const enclosures = parsed.getElementsByTagName("enclosure");
  const version = parsed.getElementsByTagNameNS(
    sparkleNamespace,
    "shortVersionString",
  );
  const build = parsed.getElementsByTagNameNS(sparkleNamespace, "version");
  const name = archivePattern.exec(archive.name)!;
  if (
    parsed.getElementsByTagName("parsererror").length ||
    items.length !== 1 ||
    enclosures.length !== 1 ||
    version.length !== 1 ||
    build.length !== 1 ||
    version[0].textContent !== name[1] ||
    build[0].textContent !== name[2] ||
    enclosures[0].getAttribute("url") !== downloadBaseUrl + archive.name ||
    enclosures[0].getAttribute("length") !== String(archive.size) ||
    enclosures[0].getAttribute("type") !== "application/octet-stream" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(
      enclosures[0].getAttributeNS(sparkleNamespace, "edSignature") ?? "",
    )
  )
    throw new Error(
      "The signed appcast does not match this DMG or dashboard download URL.",
    );
  return {
    appcastBase64: btoa(
      Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
    ),
    versionName: name[1],
    buildNumber: name[2],
    expectedSha256Hex: name[3],
  };
}

export const hashDmg = (
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) =>
  new Promise<string>((resolve, reject) => {
    validateDmg(file);
    if (signal.aborted) {
      reject(new DOMException("Hashing cancelled.", "AbortError"));
      return;
    }
    const worker = new Worker(
      new URL("../releases/apk-hash.worker.ts", import.meta.url),
      { type: "module" },
    );
    const cleanup = () => {
      signal.removeEventListener("abort", stop);
      worker.terminate();
    };
    const stop = () => {
      cleanup();
      reject(new DOMException("Hashing cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", stop, { once: true });
    worker.onmessage = (
      event: MessageEvent<{
        type: string;
        loaded?: number;
        total?: number;
        sha256Hex?: string;
        message?: string;
      }>,
    ) => {
      const data = event.data;
      if (data.type === "progress")
        onProgress((data.loaded ?? 0) / Math.max(1, data.total ?? file.size));
      if (data.type === "complete") {
        cleanup();
        if (!/^[a-f0-9]{64}$/.test(data.sha256Hex ?? ""))
          reject(new Error("The DMG hash is invalid."));
        else resolve(data.sha256Hex!);
      }
      if (data.type === "error") {
        cleanup();
        reject(new Error(data.message || "Hashing failed."));
      }
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("The DMG hash worker failed."));
    };
    worker.postMessage({ file, chunkBytes: 4 * 1024 * 1024 });
  });

export const validateMacosUploadGrant = (
  grant: MacosUploadGrant,
  sha256Hex: string,
) => {
  let url: URL;
  try {
    url = new URL(grant.url);
  } catch {
    throw new Error("The upload destination must use secure HTTPS.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("The upload destination must use secure HTTPS.");
  if (!/^[a-f0-9]{64}$/.test(sha256Hex))
    throw new Error("The DMG hash is invalid.");
  const entries = Object.entries(grant.headers);
  const headers = new Map(
    entries.map(([key, value]) => [key.toLowerCase(), value]),
  );
  const checksum = btoa(
    String.fromCharCode(
      ...sha256Hex.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
    ),
  );
  if (
    grant.method !== "PUT" ||
    entries.length !== 4 ||
    headers.size !== 4 ||
    entries.some(([key, value]) =>
      Array.from(key + value).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 0x20 || code === 0x7f;
      }),
    ) ||
    headers.get("content-type") !== "application/octet-stream" ||
    headers.get("if-none-match") !== "*" ||
    headers.get("x-amz-checksum-sha256") !== checksum ||
    headers.get("x-amz-meta-sha256") !== checksum
  )
    throw new Error(
      "The upload grant does not match the immutable DMG hash and headers.",
    );
  if (
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    Date.parse(grant.expiresAt) <= Date.now()
  )
    throw new Error(
      "The upload grant expired. Recover a new grant for this draft.",
    );
};

export async function uploadDmg(
  grant: MacosUploadGrant,
  file: File,
  signal: AbortSignal,
  sha256Hex: string,
) {
  validateDmg(file);
  validateMacosUploadGrant(grant, sha256Hex);
  if (archivePattern.exec(file.name)?.[3] !== sha256Hex)
    throw new Error("The DMG filename does not match its SHA-256.");
  if (signal.aborted) throw new DOMException("Upload cancelled.", "AbortError");
  let response: Response;
  try {
    response = await fetch(grant.url, {
      method: "PUT",
      headers: grant.headers,
      body: file,
      signal,
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  } catch {
    if (signal.aborted)
      throw new DOMException(
        "Upload cancelled. Verify the draft before uploading again.",
        "AbortError",
      );
    throw new Error(
      "The upload response was lost. Verify the draft before uploading again.",
    );
  }
  if (!response.ok)
    throw new Error(
      "The upload was rejected. Verify the draft before recovering an upload grant.",
    );
}
