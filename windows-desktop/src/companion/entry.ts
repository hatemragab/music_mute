// Trusted native entry only. The browser/renderer never import this module.
export {
  executeDesktopRequest,
  safeDesktopCode,
} from "../../../chrome-extension/src/companion/desktop-service.js";
export {
  parseDesktopRequest,
  DESKTOP_PROTOCOL_VERSION,
} from "../../../chrome-extension/src/shared/desktop-protocol.js";
