/** Pure bounded diagnostic redaction; importing this never loads a process supervisor. */
export function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/\S+/giu, "[REDACTED_URL]")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(token|secret|password|credential|authorization)\s*[=:]\s*\S+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\/Users\/[^/\s]+/gu, "/Users/[REDACTED]")
    .replace(/C:\\Users\\[^\\\s]+/giu, "C:\\Users\\[REDACTED]");
}
