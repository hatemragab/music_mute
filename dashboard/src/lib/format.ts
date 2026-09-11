export const formatDateTime = (value: string | null | undefined) => {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
};

export const formatDuration = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "No timing data";
  }
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
};

export const formatBytes = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined) return "Not available";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let index = 0;
  while (size >= 1000 && index < units.length - 1) {
    size /= 1000;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export const titleCase = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
