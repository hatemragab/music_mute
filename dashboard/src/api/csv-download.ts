import type { ApiClient } from "./api-client";

export async function downloadCsv(
  client: ApiClient,
  path: string,
  fallbackFilename: string,
  signal?: AbortSignal,
) {
  const result = await client.download(path, signal);
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename || fallbackFilename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return { filename: anchor.download, contentType: result.contentType };
}
