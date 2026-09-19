import { describe, expect, it } from "vitest";
import {
  LeaseAuthority,
  OwnershipLostError,
  type LocalClock,
} from "../src/runtime/lease-authority.js";

class FakeClock implements LocalClock {
  monotonic = 1_000;
  wall = 10_000;

  monotonicMs(): number {
    return this.monotonic;
  }

  wallMs(): number {
    return this.wall;
  }
}

describe("lease authority", () => {
  it("uses server durations and expires on either monotonic or forward wall time", () => {
    const clock = new FakeClock();
    const authority = new LeaseAuthority(
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:30.000Z",
      "2026-01-01T00:05:00.000Z",
      5_000,
      clock,
    );
    expect(authority.remainingMs()).toBe(85_000);

    clock.monotonic += 10_000;
    expect(authority.remainingMs()).toBe(75_000);

    clock.wall += 80_000;
    expect(authority.remainingMs()).toBe(5_000);
    clock.wall += 5_001;
    expect(() => authority.assertCurrent()).toThrow(OwnershipLostError);
  });

  it("anchors renewal at request start and never revives lost ownership", () => {
    const clock = new FakeClock();
    const authority = new LeaseAuthority(
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:30.000Z",
      "2026-01-01T00:05:00.000Z",
      5_000,
      clock,
    );
    const started = authority.sample();
    clock.monotonic += 2_000;
    clock.wall += 2_000;
    authority.refresh(
      "2026-01-01T00:00:20.000Z",
      "2026-01-01T00:01:50.000Z",
      started,
    );
    expect(authority.remainingMs()).toBe(83_000);

    authority.lose("cancelled");
    expect(() =>
      authority.refresh(
        "2026-01-01T00:00:40.000Z",
        "2026-01-01T00:02:10.000Z",
        authority.sample(),
      ),
    ).toThrow(OwnershipLostError);
  });
});
