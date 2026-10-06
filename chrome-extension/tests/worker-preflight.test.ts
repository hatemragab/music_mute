import { beforeEach, expect, it, vi } from "vitest";

const { load, supports, retire, reclaim } = vi.hoisted(() => ({
  load: vi.fn(),
  supports: vi.fn(),
  retire: vi.fn(),
  reclaim: vi.fn(),
}));
vi.mock("../../worker/src/runtime/personal-admission.js", () => ({
  reclaimIdlePersonalReservation: reclaim,
}));
vi.mock("../src/companion/config.js", () => ({ loadLocalConfig: load }));
vi.mock("../src/companion/local-engine.js", () => ({
  supportsLocalEngine: supports,
  retireIdleLocalEngine: retire,
}));
import { retireAppEngineForWorker } from "../src/companion/worker-preflight.js";

beforeEach(() => {
  vi.clearAllMocks();
  load.mockImplementation(async (environment) => ({
    app_resources: environment.MUSICMUTE_LOCAL_APP_RESOURCES,
    root: environment.MUSICMUTE_LOCAL_ROOT,
  }));
  supports.mockResolvedValue(true);
  retire.mockResolvedValue(undefined);
  reclaim.mockResolvedValue(undefined);
});

it("retires the exact app engine without inheriting developer paths or mutating process environment", async () => {
  const previous = process.env.MUSICMUTE_LOCAL_MODELS;
  process.env.MUSICMUTE_LOCAL_MODELS = "/fixture/developer/models";
  try {
    await Promise.all([
      retireAppEngineForWorker(
        "/fixture/app-one/Resources",
        "/fixture/support-one",
      ),
      retireAppEngineForWorker(
        "/fixture/app-two/Resources",
        "/fixture/support-two",
      ),
    ]);
    expect(load.mock.calls).toEqual([
      [
        {
          MUSICMUTE_LOCAL_APP_RESOURCES: "/fixture/app-one/Resources",
          MUSICMUTE_LOCAL_ROOT: "/fixture/support-one",
        },
      ],
      [
        {
          MUSICMUTE_LOCAL_APP_RESOURCES: "/fixture/app-two/Resources",
          MUSICMUTE_LOCAL_ROOT: "/fixture/support-two",
        },
      ],
    ]);
    expect(retire.mock.calls.map(([config]) => config.root)).toEqual([
      "/fixture/support-one",
      "/fixture/support-two",
    ]);
    expect(process.env.MUSICMUTE_LOCAL_MODELS).toBe(
      "/fixture/developer/models",
    );
    expect(reclaim.mock.calls).toEqual([
      ["/fixture/MusicMuteWorker/state"],
      ["/fixture/MusicMuteWorker/state"],
    ]);
  } finally {
    if (previous === undefined) delete process.env.MUSICMUTE_LOCAL_MODELS;
    else process.env.MUSICMUTE_LOCAL_MODELS = previous;
  }
});

it.each(["relative", "/fixture/../foreign", "/fixture//ambiguous"])(
  "rejects untrusted preparation path %s before touching an engine",
  async (path) => {
    await expect(
      retireAppEngineForWorker(path, "/fixture/support"),
    ).rejects.toThrow("WORKER_COORDINATION_UNSAFE");
    expect(load).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  },
);

it("refuses one-shot engines and preserves a busy engine failure without starting or killing work", async () => {
  supports.mockResolvedValue(false);
  await expect(
    retireAppEngineForWorker("/fixture/app/Resources", "/fixture/support"),
  ).rejects.toThrow("ENGINE_SERVICE_REQUIRED");
  expect(retire).not.toHaveBeenCalled();
  supports.mockResolvedValue(true);
  retire.mockRejectedValue(new Error("ENGINE_EXIT_UNCONFIRMED"));
  await expect(
    retireAppEngineForWorker("/fixture/app/Resources", "/fixture/support"),
  ).rejects.toThrow("ENGINE_EXIT_UNCONFIRMED");
});
