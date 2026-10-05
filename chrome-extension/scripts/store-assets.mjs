import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/** Listing images use the real popup rendered by the isolated browser fixture. */
export async function createStoreAssets(context, popup, output) {
  const directory = join(output, "store-assets");
  await mkdir(directory, { recursive: true });
  const popupBytes = await popup.locator("body").screenshot();
  const mark = await readFile(
    resolve(import.meta.dirname, "../src/extension/static/musicmute-mark.svg"),
  );
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setContent(`<!doctype html><html><head><style>
      *{box-sizing:border-box}body{margin:0;background:#101115;color:#f2f0f5;font:22px/1.5 system-ui,sans-serif}
      main{height:800px;padding:64px 80px;display:flex;align-items:center;justify-content:space-between;gap:60px;background:radial-gradient(ellipse at 80% 40%,#163c33 0,transparent 65%)}
      .copy{max-width:560px}.brand{display:flex;align-items:center;gap:18px;color:#96e6c7;font-size:24px;font-weight:650}.brand img{width:56px;height:56px}
      h1{font-size:64px;line-height:1.06;letter-spacing:-2px;margin:32px 0}h1 span{color:#96e6c7}.intro{font-size:24px;color:#c5c9ca;max-width:470px}
      ul{padding:0;list-style:none;margin:32px 0}li{margin:12px 0;font-size:20px}li:before{content:'✓';color:#96e6c7;margin-right:14px}
      .requirements{font-size:17px;color:#96e6c7}.note{font-size:13px;color:#a3aaa8;margin-top:30px}
      .popup{width:384px;flex:none;border-radius:18px;box-shadow:0 20px 80px #0008;overflow:hidden;border:1px solid #3a3c47}.popup img{width:100%;display:block}
    </style></head><body><main><section class="copy"><div class="brand"><img src="data:image/svg+xml;base64,${mark.toString("base64")}" alt="">MusicMute Local</div><h1>Keep the voice.<br><span>Enjoy the video.</span></h1><p class="intro">Prepare vocals on your Mac and listen alongside your YouTube video.</p><ul><li>Play, pause and seek in sync</li><li>Switch back to the original sound</li><li>Choose when to start and stop</li></ul><p class="requirements">Requires the MusicMute app on an Apple Silicon Mac.</p><p class="note">Actual extension interface shown with synthetic test media.</p></section><div class="popup"><img src="data:image/png;base64,${popupBytes.toString("base64")}" alt="MusicMute Local popup"></div></main></body></html>`);
    await page.screenshot({ path: join(directory, "screenshot-1280x800.png") });
    await page.setViewportSize({ width: 440, height: 280 });
    await page.setContent(
      `<!doctype html><html><head><style>body{margin:0;width:440px;height:280px;display:grid;place-items:center;background:radial-gradient(ellipse at center,#26705b,#102e29 65%,#101115)}img{width:144px;height:144px;box-shadow:0 15px 60px #0005;border-radius:42px}.wave{position:absolute;left:32px;right:32px;height:2px;background:#96e6c733;z-index:-1}body{isolation:isolate}</style></head><body><div class="wave"></div><img src="data:image/svg+xml;base64,${mark.toString("base64")}" alt="MusicMute"></body></html>`,
    );
    await page.screenshot({ path: join(directory, "promo-440x280.png") });
    const assets = [];
    for (const name of ["screenshot-1280x800.png", "promo-440x280.png"]) {
      const bytes = await readFile(join(directory, name));
      assets.push({
        name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    await writeFile(
      join(directory, "assets.json"),
      JSON.stringify(
        { synthetic_media: true, actual_popup: true, assets },
        null,
        2,
      ) + "\n",
    );
    return directory;
  } finally {
    await page.close();
  }
}
