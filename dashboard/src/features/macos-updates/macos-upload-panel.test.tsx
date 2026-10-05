import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, OperationOutcomeUnknownError } from "@/api/api-client";
import { MacosUploadPanel } from "./macos-upload-panel";
import type { MacosRelease } from "./macos-updates-api";

const mocks = vi.hoisted(() => ({
  reauthenticate: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  reserve: vi.fn(),
  complete: vi.fn(),
  hash: vi.fn(),
  parse: vi.fn(),
  transfer: vi.fn(),
}));
vi.mock("@/auth/admin-session", () => ({
  useApiClient: () => ({ get: mocks.get }),
  useAdminSession: () => ({ reauthenticate: mocks.reauthenticate }),
}));
vi.mock("./macos-updates-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./macos-updates-api")>()),
  createMacosDraft: mocks.create,
  reserveMacosUpload: mocks.reserve,
  completeMacosUpload: mocks.complete,
}));
vi.mock("./macos-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./macos-upload")>()),
  hashDmg: mocks.hash,
  readSignedAppcast: mocks.parse,
  uploadDmg: mocks.transfer,
}));
const sha = "0".repeat(64);
const release: MacosRelease = {
  id: "release",
  versionName: "1.2.3",
  buildNumber: "4",
  archiveName: `MusicMute-1.2.3-4-arm64-${sha}.dmg`,
  bytes: 7,
  sha256Hex: sha,
  state: "draft",
  artifactState: "awaiting_upload",
  revision: 1,
  createdAt: "2026-10-04T00:00:00Z",
  publishedAt: null,
  downloadUrl: "https://api.example.test/update.dmg",
};
const config = {
  revision: 1,
  publicEdKey: "A".repeat(43) + "=",
  feedUrl: "https://api.example.test/appcast.xml",
  downloadBaseUrl: "https://api.example.test/macos-updates/artifacts/",
  configured: true,
  selectedReleaseId: null,
};
const grant = {
  method: "PUT",
  url: "https://storage.example.test/file",
  headers: {},
  expiresAt: "2099-01-01T00:00:00Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.hash.mockResolvedValue(sha);
  mocks.parse.mockResolvedValue({
    appcastBase64: "signed",
    expectedSha256Hex: sha,
  });
  mocks.reauthenticate.mockResolvedValue(undefined);
  mocks.transfer.mockResolvedValue(undefined);
  mocks.complete.mockResolvedValue({
    ...release,
    artifactState: "verified",
    revision: 2,
  });
});

async function select(
  user: ReturnType<typeof userEvent.setup>,
  includeAppcast = true,
) {
  await user.upload(
    screen.getByLabelText("Prepared DMG"),
    new File(["fixture"], release.archiveName),
  );
  if (includeAppcast)
    await user.upload(
      screen.getByLabelText("Signed appcast.xml"),
      new File(["fixture"], "appcast.xml"),
    );
  await user.type(
    screen.getByLabelText("Upload reason"),
    "Ship tested Mac update",
  );
  await user.click(screen.getByRole("button", { name: "Hash and upload" }));
}

describe("MacosUploadPanel", () => {
  it("holds one upload while the signed appcast is still being read", async () => {
    let finishReading!: (value: {
      appcastBase64: string;
      expectedSha256Hex: string;
    }) => void;
    mocks.parse.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReading = resolve;
        }),
    );
    mocks.create.mockResolvedValue({ release, grant });
    const user = userEvent.setup();
    render(<MacosUploadPanel config={config} onChange={async () => {}} />);
    await select(user);
    const submit = screen.getByRole("button", { name: "Preparing update" });
    expect(submit).toBeDisabled();
    expect(screen.getByLabelText("Prepared DMG")).toBeDisabled();
    expect(screen.getByLabelText("Signed appcast.xml")).toBeDisabled();
    expect(screen.getByLabelText("Upload reason")).toBeDisabled();
    await user.dblClick(submit);
    expect(mocks.parse).toHaveBeenCalledOnce();
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    finishReading({ appcastBase64: "signed", expectedSha256Hex: sha });
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    expect(mocks.hash).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.transfer).toHaveBeenCalledOnce();
  });

  it("preserves the original reservation revision when recovering a lost resume grant", async () => {
    const advancedRelease = { ...release, revision: 2 };
    mocks.reserve
      .mockResolvedValueOnce({ release: advancedRelease, grant: null })
      .mockResolvedValueOnce({ release: advancedRelease, grant });
    const user = userEvent.setup();
    render(
      <MacosUploadPanel
        config={config}
        existingRelease={release}
        onChange={async () => {}}
      />,
    );
    await select(user, false);
    await user.click(
      await screen.findByRole("button", {
        name: "Recover upload grant and resume",
      }),
    );
    await waitFor(() => expect(mocks.reserve).toHaveBeenCalledTimes(2));
    expect(mocks.reserve.mock.calls[0][2]).toEqual(
      mocks.reserve.mock.calls[1][2],
    );
    expect(mocks.reserve.mock.calls[1][2]).toMatchObject({
      expectedRevision: 1,
    });
  });
  it("reads the draft when a long verification has no receipt and explicitly retries the same operation", async () => {
    mocks.create.mockResolvedValue({ release, grant });
    mocks.complete.mockImplementationOnce((_client, _id, operationId) =>
      Promise.reject(
        new OperationOutcomeUnknownError(
          operationId,
          "Verification response lost",
        ),
      ),
    );
    mocks.get
      .mockRejectedValueOnce(new ApiError({ status: 404 }))
      .mockResolvedValueOnce(release);
    const user = userEvent.setup();
    render(<MacosUploadPanel config={config} onChange={async () => {}} />);
    await select(user);
    await screen.findByText(/Verification response lost/);
    await user.click(
      screen.getByRole("button", { name: "Check operation outcome" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Retry verification with same operation ID",
      }),
    );
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(2));
    expect(mocks.complete.mock.calls[0][2]).toBe(
      mocks.complete.mock.calls[1][2],
    );
    expect(mocks.transfer).toHaveBeenCalledOnce();
    expect(mocks.get).toHaveBeenLastCalledWith("/admin/macos-updates/release");
  });
  it("resumes a draft after reload using only the matching DMG and a fresh grant", async () => {
    mocks.reserve.mockResolvedValue({ release, grant });
    const user = userEvent.setup();
    render(
      <MacosUploadPanel
        config={config}
        existingRelease={release}
        onChange={async () => {}}
      />,
    );
    expect(
      screen.queryByLabelText("Signed appcast.xml"),
    ).not.toBeInTheDocument();
    await select(user, false);
    await waitFor(() => expect(mocks.complete).toHaveBeenCalled());
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.anything(),
      release.id,
      expect.objectContaining({
        expectedRevision: 1,
        reason: "Ship tested Mac update",
        operationId: expect.any(String),
      }),
    );
    expect(mocks.transfer).toHaveBeenCalledOnce();
    expect(mocks.reauthenticate).toHaveBeenCalledTimes(2);
  });
  it("rejects a different DMG before reserving or uploading", async () => {
    const user = userEvent.setup();
    render(
      <MacosUploadPanel
        config={config}
        existingRelease={release}
        onChange={async () => {}}
      />,
    );
    await user.upload(
      screen.getByLabelText("Prepared DMG"),
      new File(["different-size"], release.archiveName),
    );
    await user.type(screen.getByLabelText("Upload reason"), "Resume draft");
    await user.click(screen.getByRole("button", { name: "Hash and upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "same prepared DMG",
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
  it("requires explicit grant recovery and retains the original operation ID", async () => {
    mocks.create
      .mockResolvedValueOnce({ release, grant: null })
      .mockResolvedValueOnce({ release, grant });
    const user = userEvent.setup();
    render(<MacosUploadPanel config={config} onChange={async () => {}} />);
    await select(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "grant response was lost",
    );
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.transfer).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Recover upload grant and resume" }),
    );
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    expect(mocks.create.mock.calls[0][1]).toEqual(
      mocks.create.mock.calls[1][1],
    );
  });
  it("fences unresolved operations and only checks receipts on user action", async () => {
    mocks.create.mockRejectedValue(
      new OperationOutcomeUnknownError("pending-op", "Pending outcome"),
    );
    mocks.get.mockResolvedValue({ status: "pending" });
    const user = userEvent.setup();
    const unresolved = vi.fn();
    render(
      <MacosUploadPanel
        config={config}
        onChange={async () => {}}
        onUnresolved={unresolved}
      />,
    );
    await select(user);
    await screen.findByText(/Pending outcome/);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(unresolved).toHaveBeenCalledWith(true);
    expect(
      screen.queryByRole("button", { name: "Recover upload grant and resume" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Check operation outcome" }),
    );
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});
