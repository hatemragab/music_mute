// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { ModalDialog } from "../src/renderer/dialog.js";
afterEach(cleanup);
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open confirmation</button>
      {open && (
        <ModalDialog
          label="Fixture confirmation"
          onClose={() => setOpen(false)}
        >
          <button>Confirm</button>
          <button onClick={() => setOpen(false)}>Cancel</button>
        </ModalDialog>
      )}
    </>
  );
}
it("traps keyboard focus and restores the initiating button after Escape", () => {
  render(<Fixture />);
  const initial = screen.getByRole("button", { name: "Open confirmation" });
  initial.focus();
  fireEvent.click(initial);
  const first = screen.getByRole("button", { name: "Confirm" }),
    last = screen.getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(initial);
});
