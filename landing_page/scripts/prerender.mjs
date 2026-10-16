import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiler = await createServer({
  root,
  appType: "custom",
  server: { middlewareMode: true, watch: null },
});

try {
  const { renderPage } = await compiler.ssrLoadModule("/src/prerender.tsx");
  for (const [language, entry] of [
    ["en", "index.html"],
    ["ar", "ar/index.html"],
  ]) {
    const path = new URL(`../dist/${entry}`, import.meta.url);
    const html = await readFile(path, "utf8");
    if (!html.includes('<div id="root"></div>'))
      throw new Error(`Missing prerender root in ${entry}`);
    const { markup, structuredData } = renderPage(language);
    await writeFile(
      path,
      html
        .replace('<div id="root"></div>', `<div id="root">${markup}</div>`)
        .replace(
          "</head>",
          `<script type="application/ld+json">${structuredData}</script></head>`,
        ),
    );
  }
} finally {
  await compiler.close();
}
