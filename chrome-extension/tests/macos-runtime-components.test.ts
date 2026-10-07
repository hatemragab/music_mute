import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

type Component = {
  id: string;
  url: string;
  archive_bytes: number;
  archive_sha256: string;
  file_paths: string[];
};
type Manifest = {
  url: string;
  archive_format: string;
  archive_bytes: number;
  archive_sha256: string;
  download_hosts: string[];
  files: { path: string; type: string; link_target?: string }[];
  components: Component[];
};
const module = (await import(
  new URL("../scripts/macos-runtime-components.mjs", import.meta.url).href
)) as {
  runtimeComponentForPath(path: string): string;
  validateRuntimeComponents(runtime: Manifest): void;
  relocateRuntimeComponents(
    runtime: Manifest,
    configuration: { baseURL?: URL; redirectHosts?: string },
  ): Manifest;
};

function fixture(): Manifest {
  const components = [
    { id: "python-ml", file_paths: ["runtime/runtime/python/bin/python3"] },
    { id: "node", file_paths: ["runtime/runtime/node/bin/node"] },
  ].map((component, index) => ({
    ...component,
    url: `https://github.com/ahmed-dev-1/musicmute-downloads/releases/download/v1/${component.id}.zip`,
    archive_bytes: 100 + index,
    archive_sha256: createHash("sha256").update(component.id).digest("hex"),
  }));
  return {
    url: "https://github.com/ahmed-dev-1/musicmute-downloads/releases/download/v1/runtime-bootstrap.json",
    archive_format: "zip-components",
    archive_bytes: 201,
    archive_sha256: createHash("sha256")
      .update(components.map((item) => item.archive_sha256).join("\n") + "\n")
      .digest("hex"),
    download_hosts: ["github.com", "release-assets.githubusercontent.com"],
    components,
    files: components.flatMap((item) =>
      item.file_paths.map((path) => ({ path, type: "file" })),
    ),
  };
}

describe("runtime component distribution", () => {
  it("partitions the approved runtime and rejects arbitrary app data", () => {
    expect(
      module.runtimeComponentForPath("runtime/runtime/python/lib/torch.dylib"),
    ).toBe("python-ml");
    expect(
      module.runtimeComponentForPath("runtime/tools/youtube/bin/deno"),
    ).toBe("javascript");
    expect(
      module.runtimeComponentForPath(
        "runtime/tools/youtube/provider/server.js",
      ),
    ).toBe("token-provider");
    expect(() => module.runtimeComponentForPath("account-state.json")).toThrow(
      "RUNTIME_COMPONENT_PATH_UNAPPROVED",
    );
    expect(() =>
      module.runtimeComponentForPath("models/Kim_Vocal_2.onnx"),
    ).toThrow("RUNTIME_COMPONENT_PATH_UNAPPROVED");
  });

  it("accepts a complete disjoint inventory with exact aggregate sizes and hashes", () => {
    expect(() => module.validateRuntimeComponents(fixture())).not.toThrow();
  });

  it("relocates every component and the host allowlist without changing payload identity", () => {
    const original = fixture();
    const relocated = module.relocateRuntimeComponents(original, {
      baseURL: new URL("https://downloads.music-mute.com/releases/runtime-v1/"),
      redirectHosts: "",
    });
    expect(relocated.url).toBe(
      "https://downloads.music-mute.com/releases/runtime-v1/runtime-bootstrap.json",
    );
    expect(relocated.download_hosts).toEqual(["downloads.music-mute.com"]);
    expect(relocated.components.map((item) => item.url)).toEqual([
      "https://downloads.music-mute.com/releases/runtime-v1/python-ml.zip",
      "https://downloads.music-mute.com/releases/runtime-v1/node.zip",
    ]);
    expect(
      relocated.components.map(({ url: _url, ...identity }) => identity),
    ).toEqual(
      original.components.map(({ url: _url, ...identity }) => identity),
    );
    expect(relocated.archive_sha256).toBe(original.archive_sha256);
    expect(relocated.archive_bytes).toBe(original.archive_bytes);
    expect(relocated.files).toEqual(original.files);
    expect(original.download_hosts).toEqual([
      "github.com",
      "release-assets.githubusercontent.com",
    ]);
    expect(original.components[0]!.url).toContain("github.com");
  });

  it.each([
    "http://downloads.music-mute.com/releases/",
    "https://user:password@downloads.music-mute.com/releases/",
    "https://downloads.music-mute.com/releases/?token=secret",
  ])("rejects an unsafe relocation base %s", (url) => {
    expect(() =>
      module.relocateRuntimeComponents(fixture(), {
        baseURL: new URL(url),
        redirectHosts: "",
      }),
    ).toThrow();
  });

  it("keeps the bootstrap filename when publishing a distinct relocated manifest", () => {
    const original = fixture();
    original.url = original.url.replace(
      "runtime-bootstrap.json",
      "runtime-bootstrap-r2.json",
    );
    expect(
      module.relocateRuntimeComponents(original, {
        baseURL: new URL(
          "https://downloads.music-mute.com/releases/runtime-v1/",
        ),
        redirectHosts: "",
      }).url,
    ).toBe(
      "https://downloads.music-mute.com/releases/runtime-v1/runtime-bootstrap-r2.json",
    );
  });

  it.each([
    "duplicate",
    "missing",
    "foreign",
    "host",
    "bytes",
    "hash",
    "label",
  ])("rejects %s component metadata", (mutation) => {
    const value = fixture();
    const first = value.components[0]!;
    const second = value.components[1]!;
    switch (mutation) {
      case "duplicate":
        second.file_paths = first.file_paths;
        break;
      case "missing":
        value.files.push({
          path: "runtime/app/engine/pipeline.py",
          type: "file",
        });
        break;
      case "foreign":
        second.file_paths = ["../escape"];
        break;
      case "host":
        second.url = "https://unapproved.example.com/node.zip";
        break;
      case "bytes":
        value.archive_bytes++;
        break;
      case "hash":
        value.archive_sha256 = "0".repeat(64);
        break;
      case "label":
        first.id = "account-state";
        break;
    }
    expect(() => module.validateRuntimeComponents(value)).toThrow();
  });
});
