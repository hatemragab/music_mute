export const MAX_APK_BYTES = 256 * 1024 * 1024;

export const validateApk = (file: File) => {
  if (!file.name.toLowerCase().endsWith(".apk"))
    throw new Error("Select an Android APK file.");
  if (file.size <= 0) throw new Error("The APK is empty.");
  if (file.size > MAX_APK_BYTES)
    throw new Error("The APK exceeds the 256 MiB limit.");
};

export interface ApkUploadGrant {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

const validatedHeaders = (grant: ApkUploadGrant) => {
  if (grant.method !== "PUT") throw new Error("The upload grant is invalid.");
  const entries = Object.entries(grant.headers);
  const headers = new Map(
    entries.map(([name, value]) => [name.toLowerCase(), value]),
  );
  if (
    entries.length !== 3 ||
    headers.size !== 3 ||
    entries.some(([name, value]) =>
      Array.from(name + value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x20 || codePoint === 0x7f;
      }),
    ) ||
    headers.get("content-type") !== "application/vnd.android.package-archive" ||
    headers.get("if-none-match") !== "*" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(headers.get("x-amz-checksum-sha256") ?? "")
  )
    throw new Error("The upload grant is invalid.");
  return entries;
};

export const validateUploadGrant = (grant: ApkUploadGrant) => {
  let url: URL;
  try {
    url = new URL(grant.url);
  } catch {
    throw new Error("The upload destination must use secure HTTPS.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("The upload destination must use secure HTTPS.");
  validatedHeaders(grant);
};

export const hashApk = (
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) =>
  new Promise<string>((resolve, reject) => {
    validateApk(file);
    const worker = new Worker(
      new URL("./apk-hash.worker.ts", import.meta.url),
      { type: "module" },
    );
    const stop = () => {
      worker.terminate();
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
      if (event.data.type === "progress")
        onProgress(
          (event.data.loaded ?? 0) / Math.max(1, event.data.total ?? file.size),
        );
      if (event.data.type === "complete" && event.data.sha256Hex) {
        signal.removeEventListener("abort", stop);
        worker.terminate();
        resolve(event.data.sha256Hex);
      }
      if (event.data.type === "error") {
        signal.removeEventListener("abort", stop);
        worker.terminate();
        reject(new Error(event.data.message || "Hashing failed."));
      }
    };
    worker.onerror = () => {
      signal.removeEventListener("abort", stop);
      worker.terminate();
      reject(new Error("The APK hash worker failed."));
    };
    worker.postMessage({ file, chunkBytes: 4 * 1024 * 1024 });
  });

export const uploadApk = (
  grant: ApkUploadGrant,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) => {
  validateUploadGrant(grant);
  if (signal.aborted)
    return Promise.reject(new DOMException("Upload cancelled.", "AbortError"));
  onProgress(0);
  return fetch(grant.url, {
    method: grant.method,
    headers: Object.fromEntries(validatedHeaders(grant)),
    body: file,
    signal,
    redirect: "error",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  })
    .catch((error: unknown) => {
      if (
        signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        throw new DOMException("Upload cancelled.", "AbortError");
      throw new Error("The APK upload failed.");
    })
    .then((response) => {
      if (!response.ok)
        throw new Error("The private upload destination rejected the APK.");
      onProgress(1);
    });
};
