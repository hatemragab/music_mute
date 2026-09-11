import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CursorPagination } from "./cursor-pagination";

function Harness() {
  const [cursor, setCursor] = useState<string | null>(null);
  return (
    <>
      <output aria-label="Current cursor">{cursor ?? "first"}</output>
      <CursorPagination
        cursor={cursor}
        nextCursor={cursor ? null : "second-page"}
        onCursorChange={setCursor}
      />
    </>
  );
}

describe("CursorPagination", () => {
  it("moves forward with an opaque cursor and returns to the prior page", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByLabelText("Current cursor")).toHaveTextContent(
      "second-page",
    );
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByLabelText("Current cursor")).toHaveTextContent("first");
  });

  it("disables both controls while a page request is pending", () => {
    const change = vi.fn();
    render(
      <CursorPagination
        cursor={null}
        nextCursor="second-page"
        pending
        onCursorChange={change}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });
});
