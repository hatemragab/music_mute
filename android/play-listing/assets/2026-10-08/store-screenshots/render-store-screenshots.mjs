import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const html = join(root, 'play-store-screenshots.html');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const scenes = ['home', 'processing', 'player', 'library'];
const outputs = [];

function pngDimensions(path) {
  const header = readFileSync(path).subarray(0, 24);
  if (header.toString('ascii', 1, 4) !== 'PNG') throw new Error(`Not a PNG: ${path}`);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function capture(url, output, width, height, kind) {
  mkdirSync(dirname(output), { recursive: true });
  const result = spawnSync(chrome, [
    '--headless=new',
    '--hide-scrollbars',
    '--disable-gpu',
    '--disable-features=TranslateUI',
    '--force-device-scale-factor=1',
    '--incognito',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${width},${height}`,
    `--screenshot=${output}`,
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=1200',
    url,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Chrome screenshot failed for ${url}\n${result.stderr || result.stdout}`);
  }
  const dimensions = pngDimensions(output);
  if (dimensions.width !== width || dimensions.height !== height) {
    throw new Error(`Wrong dimensions for ${output}: ${dimensions.width}x${dimensions.height}`);
  }
  const bytes = statSync(output).size;
  if (bytes > 8 * 1024 * 1024) throw new Error(`Play 8 MB limit exceeded: ${output}`);
  outputs.push({
    file: output.slice(root.length + 1),
    kind,
    width,
    height,
    bytes,
    sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
  });
}

for (const device of ['phone', 'tablet']) {
  for (const locale of ['en', 'ar']) {
    for (let index = 0; index < scenes.length; index += 1) {
      const number = String(index + 1).padStart(2, '0');
      const id = `${device}-${locale}-${number}`;
      const width = device === 'phone' ? 1080 : 1440;
      const height = device === 'phone' ? 1920 : 2560;
      const output = join(root, 'renders', device, locale, `${number}-${scenes[index]}.png`);
      const url = `${pathToFileURL(html).href}?asset=${id}`;
      capture(url, output, width, height, 'play-asset');
    }
  }
}

for (const device of ['phone', 'tablet']) {
  for (const locale of ['en', 'ar']) {
    const output = join(root, 'renders', 'preview', `${device}-${locale}.png`);
    const url = `${pathToFileURL(html).href}?contact=${device}-${locale}`;
    capture(url, output, 1800, 1120, 'review-preview');
  }
}

writeFileSync(join(root, 'manifest.json'), `${JSON.stringify({
  generated: '2026-10-08',
  source: 'play-store-screenshots.html',
  playRequirements: {
    format: 'PNG',
    maxBytes: 8 * 1024 * 1024,
    aspectRatio: '9:16',
    phone: { width: 1080, height: 1920 },
    sevenInchTablet: { width: 1440, height: 2560 },
  },
  files: outputs,
}, null, 2)}\n`);

for (const item of outputs) {
  console.log(`${item.width}x${item.height} ${item.bytes} ${item.file}`);
}
