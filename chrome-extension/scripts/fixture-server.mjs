import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";

const page = `<!doctype html><html><head><meta charset="utf-8"><title>MusicMute local browser fixture</title><style>body{background:#111;color:#eee;font:16px system-ui;margin:32px}.html5-video-player{position:relative;width:900px;max-width:100%}video{width:100%;background:#222}.ytp-right-controls{height:44px;display:flex;justify-content:flex-end}.ytp-button{width:44px;height:44px;background:transparent;border:0;cursor:pointer}button{font:inherit;padding:8px;margin:4px}#label{padding:8px}</style></head><body><h1>MusicMute local fixture</h1><p>Offline synthetic media. No YouTube or model inference is used.</p><ytd-watch-flexy video-id="11111111111"><div class="html5-video-player"><video src="/video.mp4" playsinline preload="auto"></video><div class="ytp-right-controls"><button class="ytp-mute-button" aria-label="Mute original audio">Mute</button></div></div></ytd-watch-flexy><button id="play">Play / pause</button><button id="replace">Replace video element</button><button id="navigate">Change video</button><button id="ads">Toggle ad</button><div id="label"></div><script>const player=document.querySelector('.html5-video-player');const v=()=>player.querySelector('video');document.querySelector('.ytp-mute-button').onclick=()=>{v().muted=!v().muted};document.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='m'&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.repeat){v().muted=!v().muted}});document.querySelector('#play').onclick=()=>v().paused?v().play():v().pause();document.querySelector('#replace').onclick=()=>{const n=v().cloneNode();v().replaceWith(n);n.load()};document.querySelector('#navigate').onclick=()=>{document.dispatchEvent(new Event('yt-navigate-start'));history.pushState({},'', '/watch?v=22222222222');document.querySelector('ytd-watch-flexy').setAttribute('video-id','22222222222');v().load();document.dispatchEvent(new Event('yt-navigate-finish'))};document.querySelector('#ads').onclick=()=>player.classList.toggle('ad-showing');</script></body></html>`;

/** Exact owned media only; range support reflects normal seekable browser media. */
export async function startFixtureServer(videoPath) {
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/watch?")) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(page);
        return;
      }
      if (request.url === "/video.mp4") {
        const info = await stat(videoPath);
        const data = await readFile(videoPath);
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        if (range) {
          const start = Number(range[1]);
          const end = range[2]
            ? Math.min(Number(range[2]), info.size - 1)
            : info.size - 1;
          if (start > end || start >= info.size) {
            response.writeHead(416, {
              "Content-Range": `bytes */${info.size}`,
            });
            response.end();
            return;
          }
          response.writeHead(206, {
            "Content-Type": "video/mp4",
            "Content-Length": end - start + 1,
            "Content-Range": `bytes ${start}-${end}/${info.size}`,
            "Accept-Ranges": "bytes",
          });
          response.end(data.subarray(start, end + 1));
          return;
        }
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": info.size,
          "Accept-Ranges": "bytes",
        });
        response.end(data);
        return;
      }
      response.writeHead(404);
      response.end();
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
