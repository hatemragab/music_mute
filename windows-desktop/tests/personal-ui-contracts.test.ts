import { expect, it } from "vitest";
import { parsePersonalUiCommand } from "../src/shared/personal-ui-contracts.js";

const requestId = "00000000-0000-4000-8000-000000000001";
it("accepts only the bounded request cancellation descriptor without renderer authority", () => {
  expect(parsePersonalUiCommand({ type: "CANCEL_REQUEST", requestId })).toEqual(
    {
      type: "CANCEL_REQUEST",
      requestId,
    },
  );
});
it.each([
  { type: "CANCEL_REQUEST" },
  { type: "CANCEL_REQUEST", requestId: "../other" },
  { type: "CANCEL_REQUEST", requestId: null },
  { type: "CANCEL_REQUEST", requestId, jobId: requestId },
  { type: "CANCEL_REQUEST", requestId, ownerId: requestId },
  { type: "CANCEL_REQUEST", requestId, scope: null },
  { type: "CANCEL_REQUEST", requestId, path: "C:\\private.wav" },
])("rejects cancellation authority injection %j", (command) => {
  expect(() => parsePersonalUiCommand(command)).toThrow("INVALID_REQUEST");
});
