import { describe, expect, it } from "vitest";
import {
  createMacServiceLayout,
  MAC_SERVICE_LABEL,
  renderLaunchDaemonPlist,
} from "../src/platform/macos/launchd.js";

describe("macOS LaunchDaemon definition", () => {
  it("uses only the private release, state and bounded system environment", () => {
    const layout = createMacServiceLayout(
      "/private/var/db/MusicMute Test",
      "/private/var/db/LaunchDaemons",
    );
    const plist = renderLaunchDaemonPlist({
      layout,
      serviceUser: "_musicmute",
      serviceGroup: "_musicmute",
    });

    expect(plist).toContain(`<string>${MAC_SERVICE_LABEL}</string>`);
    expect(plist).toContain(
      "<string>/private/var/db/MusicMute Test/current/runtime/node/bin/node</string>",
    );
    expect(plist).toContain(
      "<string>/private/var/db/MusicMute Test/state/runtime.json</string>",
    );
    expect(plist).toContain("<string>/usr/bin:/bin:/usr/sbin:/sbin</string>");
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(plist).not.toContain("credential");
    expect(plist).not.toContain("AWS_");
    expect(plist).not.toContain("MONGODB");
  });

  it("escapes XML values and rejects unsafe account or root values", () => {
    const layout = createMacServiceLayout(
      "/private/var/db/MusicMute & Test",
      "/private/var/db/LaunchDaemons",
    );
    expect(
      renderLaunchDaemonPlist({
        layout,
        serviceUser: "_musicmute",
        serviceGroup: "staff",
      }),
    ).toContain("MusicMute &amp; Test");
    expect(() =>
      renderLaunchDaemonPlist({
        layout,
        serviceUser: "root; touch /tmp/bad",
        serviceGroup: "staff",
      }),
    ).toThrow("service user is invalid");
    expect(() => createMacServiceLayout("/", "/Library/LaunchDaemons")).toThrow(
      "Mac install root is unsafe",
    );
  });
});
