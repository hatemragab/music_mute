const DEFAULT = "#FF814A";
export const ACCENTS = [
  DEFAULT,
  "#48C847",
  "#2C95F7",
  "#A842EA",
  "#F45191",
  "#F5C941",
];

function luminance(color: string): number {
  const parts = [1, 3, 5].map(
    (index) => parseInt(color.slice(index, index + 2), 16) / 255,
  );
  const [red, green, blue] = parts.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}
function contrast(a: string, b: string) {
  const first = luminance(a),
    second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
function blendWhite(color: string, amount: number): string {
  return `#${[1, 3, 5]
    .map((index) =>
      Math.round(
        parseInt(color.slice(index, index + 2), 16) * (1 - amount) +
          255 * amount,
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
export function readableAccent(color: string): string {
  for (let step = 0; step <= 100; step++) {
    const candidate = blendWhite(color, step / 100);
    if (contrast(candidate, "#191B21") >= 4.5) return candidate;
  }
  return "#FFFFFF";
}
export function applyAccent(color: string) {
  const readable = readableAccent(color);
  document.documentElement.style.setProperty("--accent", readable);
  document.documentElement.style.setProperty(
    "--on-accent",
    contrast(readable, "#000000") >= contrast(readable, "#FFFFFF")
      ? "#000000"
      : "#FFFFFF",
  );
}
export function accentFor(uid: string) {
  const saved = localStorage.getItem(`musicmute.web.accent.${uid}`);
  return saved && /^#[a-f0-9]{6}$/i.test(saved) ? saved : DEFAULT;
}
export function saveAccent(uid: string, color: string) {
  if (!/^#[a-f0-9]{6}$/i.test(color)) return;
  localStorage.setItem(`musicmute.web.accent.${uid}`, color);
  applyAccent(color);
}
