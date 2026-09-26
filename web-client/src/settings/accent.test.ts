import { expect, test } from "vitest";
import { readableAccent } from "./accent";

test("lifts a dark selected color for readable controls", () => {
  expect(readableAccent("#050505")).not.toBe("#050505");
  expect(readableAccent("#FF814A")).toBe("#ff814a");
});
