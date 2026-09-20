import { describe, expect, it } from "vitest";

import {
  boundedDiagnosticLines,
  redactPrivateDiagnosticText,
  workerContactState,
} from "./worker-status";

describe("worker presentation safety", () => {
  const now = new Date("2026-09-20T02:00:00.000Z").getTime();

  it("distinguishes online, stale, offline and never-contacted machines", () => {
    expect(
      workerContactState(
        { status: "active", lastSeenAt: "2026-09-20T01:59:30.000Z" },
        now,
      ),
    ).toBe("online");
    expect(
      workerContactState(
        { status: "active", lastSeenAt: "2026-09-20T01:58:00.000Z" },
        now,
      ),
    ).toBe("stale");
    expect(
      workerContactState(
        { status: "active", lastSeenAt: "2026-09-20T01:50:00.000Z" },
        now,
      ),
    ).toBe("offline");
    expect(
      workerContactState({ status: "pending", lastSeenAt: null }, now),
    ).toBe("never");
  });

  it("bounds adversarial logs and redacts private URL and credential text", () => {
    const lines = Array.from(
      { length: 200 },
      (_, index) =>
        `line ${index} https://storage.invalid/private?signature=x credential=very-secret ${"x".repeat(2_000)}`,
    );
    const bounded = boundedDiagnosticLines(lines, 10, 100);

    expect(bounded).toHaveLength(10);
    expect(bounded.every((line) => line.length <= 100)).toBe(true);
    const redacted = redactPrivateDiagnosticText(bounded[0]);
    expect(redacted).toContain("[redacted-url]");
    expect(redacted).toContain("credential=[redacted]");
    expect(redacted).not.toContain("very-secret");

    const structured = redactPrivateDiagnosticText(
      'Authorization: Bearer header-secret {"token":"json-secret"} secret plain-secret',
    );
    expect(structured).toMatch(/authorization=\[redacted\]/i);
    expect(structured).toContain("token=[redacted]");
    expect(structured).toContain("secret=[redacted]");
    expect(structured).not.toMatch(/header-secret|json-secret|plain-secret/);
  });
});
