import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, OperationOutcomeUnknownError } from "@/api/api-client";
import { fromWireCase, toWireCase } from "@/api/wire-case";
import { DashboardFixture } from "@/test/dashboard-fixtures";
import {
  getDesktopUpdatePolicy,
  updateDesktopPolicy,
} from "./desktop-policy-api";

const input = {
  expectedRevision: 1,
  operationId: "126c449a-a2a5-4b2e-848a-c37b0a05603d",
  reason: "Require the reviewed Windows build",
  platforms: { windows: { minimumBuild: 42 } },
};
function transport(
  fixture: DashboardFixture,
  role = "release_manager",
  loseReply = false,
) {
  const bodies: unknown[] = [];
  let lost = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, options) => {
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      if (body) bodies.push(body);
      const response = await fixture.handle({
        method: options?.method ?? "GET",
        url: String(url),
        token: `${role}-fixture`,
        body: fromWireCase(body),
      });
      if (loseReply && options?.method === "PATCH" && !lost) {
        lost = true;
        throw new TypeError("Synthetic lost response after commit");
      }
      return new Response(JSON.stringify(toWireCase(response.body)), {
        status: response.status,
        headers: { "content-type": "application/json", ...response.headers },
      });
    }),
  );
  return {
    client: new ApiClient({
      origin: "https://api.example.test",
      getToken: async () => `${role}-fixture`,
    }),
    bodies,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("independent desktop build gate API", () => {
  it("uses snake wire keys, preserves mobile selection and omitted desktop channel", async () => {
    const fixture = new DashboardFixture();
    fixture.desktopGates.macos.minimumBuild = 21;
    const mobile = structuredClone(fixture.policy),
      { client, bodies } = transport(fixture);
    await expect(getDesktopUpdatePolicy(client)).resolves.toEqual({
      revision: 1,
      macos: { minimumBuild: 21 },
      windows: { minimumBuild: null },
    });
    await expect(updateDesktopPolicy(client, input)).resolves.toMatchObject({
      policy: {
        revision: 2,
        windows: { minimumBuild: 42 },
        macos: { minimumBuild: 21 },
      },
      appliedRevision: 2,
      replayed: false,
    });
    expect(bodies).toEqual([
      {
        expected_revision: 1,
        operation_id: input.operationId,
        reason: input.reason,
        platforms: { windows: { minimum_build: 42 } },
      },
    ]);
    expect(fixture.policy).toEqual({ ...mobile, revision: 2 });
    expect(fixture.releases.map((r) => r.state)).toEqual([
      "draft",
      "published",
    ]);
  });
  it("denies viewer writes and rejects stale global policy revisions", async () => {
    const fixture = new DashboardFixture(),
      { client } = transport(fixture, "viewer");
    await expect(updateDesktopPolicy(client, input)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    const writer = transport(fixture).client;
    fixture.policy.revision = 2;
    await expect(updateDesktopPolicy(writer, input)).rejects.toMatchObject({
      status: 409,
      code: "REVISION_CONFLICT",
    });
    expect(fixture.desktopGates.windows.minimumBuild).toBeNull();
    expect(fixture.desktopPolicyOperations.size).toBe(0);
  });
  it("reads a committed receipt after reply loss and never repeats PATCH", async () => {
    const fixture = new DashboardFixture(),
      { client } = transport(fixture, "release_manager", true);
    await expect(updateDesktopPolicy(client, input)).resolves.toMatchObject({
      appliedRevision: 2,
      replayed: true,
      policy: { revision: 2, windows: { minimumBuild: 42 } },
    });
    expect(
      fixture.requests.map((r) => [r.method, new URL(r.url).pathname]),
    ).toEqual([
      ["PATCH", "/admin/update-policy/desktop"],
      ["GET", `/admin/operations/${input.operationId}`],
      ["GET", "/admin/update-policy/desktop"],
    ]);
    expect(fixture.policy.revision).toBe(2);
  });
  it("reports uncertainty when a success receipt lacks its committed revision", async () => {
    const client = {
      patch: vi.fn().mockRejectedValue(new TypeError("Lost ACK")),
      get: vi.fn().mockResolvedValue({
        status: "succeeded",
        operationId: input.operationId,
        revision: null,
      }),
    } as unknown as ApiClient;
    await expect(updateDesktopPolicy(client, input)).rejects.toBeInstanceOf(
      OperationOutcomeUnknownError,
    );
    expect(client.patch).toHaveBeenCalledOnce();
    expect(client.get).toHaveBeenCalledOnce();
  });
  it("supports explicit clear, idempotent same-operation readback and rejects a repurposed operation ID", async () => {
    const fixture = new DashboardFixture(),
      { client } = transport(fixture);
    fixture.desktopGates.windows.minimumBuild = 12;
    const clear = { ...input, platforms: { windows: { minimumBuild: null } } };
    await expect(updateDesktopPolicy(client, clear)).resolves.toMatchObject({
      policy: { windows: { minimumBuild: null } },
      replayed: false,
    });
    await expect(updateDesktopPolicy(client, clear)).resolves.toMatchObject({
      replayed: true,
      appliedRevision: 2,
    });
    await expect(
      updateDesktopPolicy(client, { ...clear, reason: "Different command" }),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    expect(fixture.policy.revision).toBe(2);
  });
});
