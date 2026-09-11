export const MAX_APK_BYTES = 256 * 1024 * 1024;

export const validateApk = (file: File) => {
  if (!file.name.toLowerCase().endsWith(".apk"))
    throw new Error("Select an Android APK file.");
  if (file.size <= 0) throw new Error("The APK is empty.");
  if (file.size > MAX_APK_BYTES)
    throw new Error("The APK exceeds the 256 MiB limit.");
};

export const validateUploadGrant = (grant: {
  url: string;
  fields: Record<string, string>;
}) => {
  let url: URL;
  try {
    url = new URL(grant.url);
  } catch {
    throw new Error("The upload destination must use secure HTTPS.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("The upload destination must use secure HTTPS.");
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
  grant: { url: string; fields: Record<string, string> },
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) =>
  new Promise<void>((resolve, reject) => {
    validateUploadGrant(grant);
    const request = new XMLHttpRequest();
    const form = new FormData();
    for (const [key, value] of Object.entries(grant.fields))
      form.append(key, value);
    form.append("file", file);
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      signal.removeEventListener("abort", abort);
      if (request.status >= 200 && request.status < 300) {
        resolve();
      } else {
        reject(new Error("The private upload destination rejected the APK."));
      }
    };
    request.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("The APK upload failed."));
    };
    request.onabort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Upload cancelled.", "AbortError"));
    };
    request.open("POST", grant.url);
    request.send(form);
  });
