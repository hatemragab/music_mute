import { runBrowserHost } from "./browser-host.js";

// Standalone native-host entry only. Imported browser-host is side-effect free.
runBrowserHost().catch(() => {
  process.stderr.write("MusicMute browser host unavailable\n");
  process.exitCode = 1;
});
