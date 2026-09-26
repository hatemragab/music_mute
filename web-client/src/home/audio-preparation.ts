import type { Conversion as ConversionType } from "mediabunny";

export const AUDIO_TYPES = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  aac: "audio/aac",
  mp3: "audio/mpeg",
} as const;
export type AudioExtension = keyof typeof AUDIO_TYPES;
const COMPATIBLE = new Set<AudioExtension>([
  "m4a",
  "mp4",
  "webm",
  "opus",
  "ogg",
  "aac",
  "mp3",
]);

export function classifyAudio(
  name: string,
  bytes: number,
  durationSeconds: number,
): { extension: AudioExtension | null; convert: boolean } {
  const extension = name.split(".").pop()?.toLowerCase() || "";
  const known = extension in AUDIO_TYPES ? (extension as AudioExtension) : null;
  const averageBitrate =
    durationSeconds > 0 ? (bytes * 8) / durationSeconds : Infinity;
  return {
    extension: known,
    convert: !known || !COMPATIBLE.has(known) || averageBitrate > 160_000,
  };
}

export async function inspectDuration(
  file: File,
  signal: AbortSignal,
): Promise<number> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number>((resolve, reject) => {
      const audio = new Audio();
      const clear = () => {
        audio.removeAttribute("src");
        audio.load();
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        clear();
        reject(new DOMException("Cancelled", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      audio.onloadedmetadata = () => {
        const duration = audio.duration;
        clear();
        if (Number.isFinite(duration) && duration > 0) resolve(duration);
        else reject(new Error("AUDIO_DURATION_UNAVAILABLE"));
      };
      audio.onerror = () => {
        clear();
        reject(new Error("AUDIO_FORMAT_UNSUPPORTED"));
      };
      audio.preload = "metadata";
      audio.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareAudio(
  file: File,
  durationSeconds: number,
  signal: AbortSignal,
): Promise<{ blob: Blob; extension: AudioExtension; contentType: string }> {
  const classification = classifyAudio(file.name, file.size, durationSeconds);
  if (!classification.convert && classification.extension)
    return {
      blob: file,
      extension: classification.extension,
      contentType: AUDIO_TYPES[classification.extension],
    };
  if (file.size > 80_000_000) throw new Error("BROWSER_CONVERSION_SIZE_LIMIT");
  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    canEncodeAudio,
  } = await import("mediabunny");
  if (!(await canEncodeAudio("aac"))) {
    const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
    registerAacEncoder();
  }
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  let conversion: ConversionType | null = null;
  let timedOut = false;
  const abort = () => {
    if (conversion) void conversion.cancel();
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, 120_000);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (!(await input.canRead()) || !(await input.getPrimaryAudioTrack()))
      throw new Error("AUDIO_FORMAT_UNSUPPORTED");
    conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { discard: true },
      audio: {
        codec: "aac",
        bitrate: 160_000,
        numberOfChannels: 2,
        forceTranscode: true,
      },
      copy: false,
      showWarnings: false,
    });
    if (!conversion.isValid) throw new Error("AUDIO_CONVERSION_FAILED");
    if (signal.aborted || timedOut) {
      await conversion.cancel();
      throw new Error("AUDIO_CONVERSION_CANCELLED");
    }
    await conversion.execute();
    if (!target.buffer?.byteLength) throw new Error("AUDIO_CONVERSION_FAILED");
    return {
      blob: new Blob([target.buffer], { type: "audio/mp4" }),
      extension: "m4a",
      contentType: "audio/mp4",
    };
  } catch (error) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (timedOut)
      throw new Error("BROWSER_CONVERSION_TIMEOUT", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    input.dispose();
  }
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export interface UploadGrant {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}
export function uploadWithProgress(
  grant: UploadGrant,
  blob: Blob,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
): Promise<void> {
  if (grant.method !== "PUT" || new URL(grant.url).protocol !== "https:")
    throw new Error("INVALID_UPLOAD_GRANT");
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", grant.url);
    xhr.withCredentials = false;
    for (const [key, value] of Object.entries(grant.headers))
      xhr.setRequestHeader(key, value);
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      signal.removeEventListener("abort", abort);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`UPLOAD_HTTP_${xhr.status}`));
    };
    xhr.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("UPLOAD_NETWORK_ERROR"));
    };
    xhr.onabort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    xhr.send(blob);
  });
}
