export function formatActionResult(
  value: Record<string, unknown>,
  json: boolean,
): string {
  if (json) return formatJson(value);
  const action =
    typeof value.action === "string" ? humanizeLabel(value.action) : "Command";
  const result =
    value.status === "ok"
      ? "Success"
      : typeof value.status === "string"
        ? humanizeLabel(value.status)
        : "Success";
  const lines = [`MusicMute Worker ${action}`, "", `Result: ${result}`];
  appendDetails(
    lines,
    {
      ...value,
      ...(typeof value.outcome === "string"
        ? { outcome: humanizeLabel(value.outcome) }
        : {}),
    },
    0,
    new Set(["action", "schemaVersion", "status"]),
  );
  if (value.capacityRequalificationRequired === true)
    lines.push(
      "",
      "Updated with one worker per GPU. Benchmark the new release before enabling a second worker; backend approval is still required.",
    );
  return lines.join("\n");
}

export function formatDetailedResult(
  title: string,
  value: unknown,
  json: boolean,
): string {
  if (json) return formatJson(value);
  const lines = [title, ""];
  appendDetails(lines, value);
  return lines.join("\n");
}

export function appendDetails(
  lines: string[],
  value: unknown,
  indent = 0,
  omittedKeys: ReadonlySet<string> = new Set(),
): void {
  const padding = " ".repeat(indent);
  if (!isRecord(value)) {
    lines.push(`${padding}${formatScalar(value)}`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (omittedKeys.has(key)) continue;
    const label = humanizeLabel(key);
    if (isRecord(child)) {
      lines.push(`${padding}${label}:`);
      appendDetails(lines, child, indent + 2);
    } else if (Array.isArray(child)) {
      lines.push(`${padding}${label}:`);
      if (child.length === 0) lines.push(`${padding}  None`);
      else {
        for (const item of child) {
          if (isRecord(item)) {
            lines.push(`${padding}  -`);
            appendDetails(lines, item, indent + 4);
          } else lines.push(`${padding}  - ${formatScalar(item)}`);
        }
      }
    } else lines.push(`${padding}${label}: ${formatScalar(child)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "Not available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return formatJson(value);
}

export function formatJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Command result is not serializable");
  return encoded;
}

export function humanizeLabel(value: string): string {
  const acronyms: Readonly<Record<string, string>> = {
    api: "API",
    cpu: "CPU",
    ffmpeg: "FFmpeg",
    ffprobe: "FFprobe",
    gpu: "GPU",
    id: "ID",
    pid: "PID",
    sha256: "SHA-256",
    url: "URL",
  };
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .map((word) =>
      acronyms[word.toLowerCase()] === undefined
        ? `${word.charAt(0).toUpperCase()}${word.slice(1)}`
        : acronyms[word.toLowerCase()]!,
    )
    .join(" ");
}
