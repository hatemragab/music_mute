// The shared native account transport and Electron main process use one process
// identity/context. Packaged applications cannot activate the collector.
export {
  localDiagnostics,
  withLocalLogContext,
  currentLocalLogContext,
} from "../../../chrome-extension/src/companion/local-debug.js";
