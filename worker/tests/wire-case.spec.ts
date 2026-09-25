import { describe, expect, it } from "vitest";
import { fromWireCase, toWireCase } from "../src/runtime/wire-case.js";

describe("worker API wire case", () => {
  it("converts nested request and response fields", () => {
    expect(
      toWireCase({
        requestId: "request-1",
        leases: [{ attemptId: "attempt-1", jobId: "job-1" }],
      }),
    ).toEqual({
      request_id: "request-1",
      leases: [{ attempt_id: "attempt-1", job_id: "job-1" }],
    });
    expect(
      fromWireCase({
        _id: "record-1",
        policy_revision: 3,
        leases: [{ lease_expires_at: "2026-09-25T00:00:00.000Z" }],
      }),
    ).toEqual({
      _id: "record-1",
      policyRevision: 3,
      leases: [{ leaseExpiresAt: "2026-09-25T00:00:00.000Z" }],
    });
  });

  it("keeps signed metadata and upload headers byte-for-byte", () => {
    const opaque = {
      signed: {
        key_id: "signing-key",
        metadata: { releaseVersion: "1.0.0", nested: { modelDigest: "abc" } },
      },
      grant: {
        expires_at: "2026-09-25T00:00:00.000Z",
        headers: { "Content-Type": "audio/mpeg", "If-None-Match": "*" },
      },
    };
    expect(fromWireCase(opaque)).toEqual({
      signed: {
        keyId: "signing-key",
        metadata: opaque.signed.metadata,
      },
      grant: {
        expiresAt: "2026-09-25T00:00:00.000Z",
        headers: opaque.grant.headers,
      },
    });
  });

  it("rejects stale camelCase response keys outside opaque objects", () => {
    expect(() => fromWireCase({ machineId: "old-contract" })).toThrow(
      "non-wire key",
    );
  });
});
