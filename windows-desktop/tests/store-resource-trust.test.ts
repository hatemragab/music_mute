import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { REQUIRED_STORE_GUI_RESOURCES } from "../src/main/browser/store-resource-index.js";

// Synthetic fixed-bootstrap responses exercise resource routing and lifetime.
// StoreNativeAuthority's independent tests cover non-forgeable native admission.
const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreNativeAuthority: { open: state.open },
}));
const storeDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "windowsStore",
);
const product = STORE_PRODUCTS.gui;
const installed = `C:\\Program Files\\WindowsApps\\${product.identityName}_0.1.0.2_x64__${product.publisherId}`;
const resources = win32.join(installed, "app", "resources");
const asar = win32.join(resources, "app.asar");
function authorityFixture() {
  const bytes = new Map<string, Buffer>();
  const entries = REQUIRED_STORE_GUI_RESOURCES.map((name) => {
    const [placement, path] = name.split(":") as ["app" | "resources", string];
    const value =
      path === "desktop-build.json"
        ? Buffer.from(
            JSON.stringify({ version: 1, appVersion: "0.1.0", buildNumber: 7 }),
          )
        : Buffer.from(`sealed fixture ${path}`);
    bytes.set(
      `app/${placement === "resources" ? "resources/" : ""}${path}`,
      value,
    );
    return {
      placement,
      path,
      bytes: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  });
  const resourceIndex = {
    version: 2 as const,
    authority: {
      kind: "microsoft-store" as const,
      role: "gui" as const,
      identity: product,
      packageVersion: "0.1.0.0",
      protocolAbi: 1 as const,
    },
    appVersion: "0.1.0",
    buildNumber: 7,
    entries,
  };
  return {
    receipt: { package: { installedLocation: installed } },
    resourceIndex,
    resourceInventorySha256: createHash("sha256")
      .update(JSON.stringify(resourceIndex))
      .digest("hex"),
    readResource: vi.fn(async (path: string) => {
      const value = bytes.get(path);
      if (!value) throw new Error("STORE_AUTHORITY_DENIED");
      return value;
    }),
    close: vi.fn(async () => {}),
    bytes,
  };
}
beforeEach(() => {
  vi.resetModules();
  state.open.mockReset();
  Object.defineProperty(process, "windowsStore", {
    configurable: true,
    value: true,
  });
});
afterEach(() => {
  if (storeDescriptor)
    Object.defineProperty(process, "windowsStore", storeDescriptor);
  else Reflect.deleteProperty(process, "windowsStore");
  vi.resetModules();
});

describe("Store GUI resource loader integration", () => {
  it("uses only the fixed native bootstrap and sealed registered resources, including Store revision updates", async () => {
    const authority = authorityFixture();
    state.open.mockResolvedValue(authority);
    const trust = await import("../src/main/browser/package-trust.js");
    expect(await trust.configurePackagedResourceTrust(resources, asar)).toBe(
      authority.resourceIndex,
    );
    expect(state.open).toHaveBeenCalledExactlyOnceWith();
    const path = win32.join(resources, "desktop-public-config.json");
    const entry = authority.resourceIndex.entries.find(
      (value) => value.path === "desktop-public-config.json",
    )!;
    expect(await trust.readPackagedResource(path.toUpperCase(), 4096)).toEqual(
      authority.bytes.get("app/resources/desktop-public-config.json"),
    );
    expect(authority.readResource).toHaveBeenCalledWith(
      "app/resources/desktop-public-config.json",
      { bytes: entry.bytes, sha256: entry.sha256 },
      4096,
    );
    expect(trust.packagedResourceInventorySha256()).toBe(
      authority.resourceInventorySha256,
    );
    expect(await trust.loadPackagedDesktopBuild(resources, "0.1.0")).toEqual({
      version: 1,
      appVersion: "0.1.0",
      buildNumber: 7,
    });
    await trust.closePackagedResourceTrust();
    expect(authority.close).toHaveBeenCalledOnce();
    expect(trust.packagedResourceInventorySha256()).toBeNull();
    await expect(trust.readPackagedResource(path, 4096)).rejects.toThrow(
      "PACKAGED_TRUST_REQUIRED",
    );
  });

  it.each([
    "C:\\Users\\fixture\\copy\\desktop-build.json",
    win32.join(
      installed + "-foreign",
      "app",
      "resources",
      "desktop-build.json",
    ),
    "D:\\Program Files\\WindowsApps\\foreign\\desktop-build.json",
    win32.join(resources, "missing.json"),
    win32.join(resources, "native", "..", "..", "desktop-build.json"),
    win32.join(resources, "desktop-build.json:foreign"),
  ])(
    "denies unsealed, outside or alternate-stream resource %s before a native read",
    async (path) => {
      const authority = authorityFixture();
      state.open.mockResolvedValue(authority);
      const trust = await import("../src/main/browser/package-trust.js");
      await trust.configurePackagedResourceTrust(resources, asar);
      await expect(trust.readPackagedResource(path, 4096)).rejects.toThrow(
        "PACKAGED_TRUST_INVALID",
      );
      expect(authority.readResource).not.toHaveBeenCalled();
      await trust.closePackagedResourceTrust();
    },
  );

  it("denies malformed budgets and insufficient bounds without opening a resource", async () => {
    const authority = authorityFixture();
    state.open.mockResolvedValue(authority);
    const trust = await import("../src/main/browser/package-trust.js");
    await trust.configurePackagedResourceTrust(resources, asar);
    for (const maximum of [0, -1, 1.5, NaN, Infinity, 256 * 1024 ** 2 + 1, 1])
      await expect(
        trust.readPackagedResource(
          win32.join(resources, "desktop-build.json"),
          maximum,
        ),
      ).rejects.toThrow("PACKAGED_TRUST_INVALID");
    expect(authority.readResource).not.toHaveBeenCalled();
    await trust.closePackagedResourceTrust();
  });

  it("refuses legacy publisher, post-sign leaf, runtime capsule and a mode switch", async () => {
    state.open.mockResolvedValue(authorityFixture());
    const trust = await import("../src/main/browser/package-trust.js");
    await trust.configurePackagedResourceTrust(resources, asar);
    expect(() => trust.assertPackagedPublisher("a".repeat(64))).toThrow(
      "PACKAGED_TRUST_INVALID",
    );
    await expect(
      trust.readPostSignAppPin(
        win32.join(resources, "native", "account-authority-manifest.json"),
        4096,
      ),
    ).rejects.toThrow("PACKAGED_TRUST_INVALID");
    await expect(trust.captureWorkerResourceCapsule()).rejects.toThrow(
      "PACKAGED_TRUST_INVALID",
    );
    await expect(
      trust.configureWorkerResourceTrust(
        resources,
        Buffer.from("{}"),
        "a".repeat(64),
      ),
    ).rejects.toThrow("PACKAGED_TRUST_INVALID");
    Object.defineProperty(process, "windowsStore", {
      configurable: true,
      value: false,
    });
    await expect(
      trust.configurePackagedResourceTrust(resources, asar),
    ).rejects.toThrow("PACKAGED_TRUST_INVALID");
    await trust.closePackagedResourceTrust();
  });

  it("keeps native admission and servicing failures fenced instead of using source files", async () => {
    state.open.mockRejectedValue(new Error("STORE_AUTHORITY_DENIED"));
    const trust = await import("../src/main/browser/package-trust.js");
    await expect(
      trust.configurePackagedResourceTrust(resources, asar),
    ).rejects.toThrow("STORE_AUTHORITY_DENIED");
    await expect(
      trust.readPackagedResource(
        win32.join(resources, "desktop-build.json"),
        4096,
      ),
    ).rejects.toThrow("PACKAGED_TRUST_REQUIRED");
    expect(trust.packagedResourceInventorySha256()).toBeNull();
    const authority = authorityFixture();
    state.open.mockResolvedValue(authority);
    await trust.configurePackagedResourceTrust(resources, asar);
    authority.readResource.mockRejectedValueOnce(
      new Error("STORE_GENERATION_CHANGED"),
    );
    await expect(
      trust.readPackagedResource(
        win32.join(resources, "desktop-build.json"),
        4096,
      ),
    ).rejects.toThrow("STORE_GENERATION_CHANGED");
    await trust.closePackagedResourceTrust();
  });

  it("binds resource roots to the actual native package observation and closes a mismatched bootstrap", async () => {
    const authority = authorityFixture();
    state.open.mockResolvedValue(authority);
    const trust = await import("../src/main/browser/package-trust.js");
    await expect(
      trust.configurePackagedResourceTrust(
        "C:\\fixture\\resources",
        "C:\\fixture\\resources\\app.asar",
      ),
    ).rejects.toThrow("PACKAGED_TRUST_INVALID");
    expect(authority.close).toHaveBeenCalledOnce();
    expect(trust.packagedResourceInventorySha256()).toBeNull();
    await expect(
      trust.readPackagedResource(
        win32.join(resources, "desktop-build.json"),
        4096,
      ),
    ).rejects.toThrow("PACKAGED_TRUST_REQUIRED");
  });

  it("checks the protected build number as well as semantic version", async () => {
    const authority = authorityFixture();
    state.open.mockResolvedValue(authority);
    const trust = await import("../src/main/browser/package-trust.js");
    await trust.configurePackagedResourceTrust(resources, asar);
    authority.readResource.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({ version: 1, appVersion: "0.1.0", buildNumber: 8 }),
      ),
    );
    await expect(
      trust.loadPackagedDesktopBuild(resources, "0.1.0"),
    ).rejects.toThrow("PACKAGED_TRUST_INVALID");
    await trust.closePackagedResourceTrust();
  });

  it("retires a bootstrap that completes after shutdown without publishing authority", async () => {
    const authority = authorityFixture();
    let complete!: (value: typeof authority) => void;
    state.open.mockImplementation(
      () =>
        new Promise<typeof authority>((resolve) => {
          complete = resolve;
        }),
    );
    const trust = await import("../src/main/browser/package-trust.js");
    const opening = trust.configurePackagedResourceTrust(resources, asar);
    const rejected = expect(opening).rejects.toThrow("PACKAGED_TRUST_INVALID");
    const closing = trust.closePackagedResourceTrust();
    complete(authority);
    await rejected;
    await closing;
    expect(authority.close).toHaveBeenCalled();
    expect(trust.packagedResourceInventorySha256()).toBeNull();
    await expect(
      trust.configurePackagedResourceTrust(resources, asar),
    ).rejects.toThrow("PACKAGED_TRUST_INVALID");
  });
});
