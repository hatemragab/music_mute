import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, Outlet, RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { UnsavedChangesGuard } from "./unsaved-changes-guard";

function Editor() {
  return (
    <>
      <UnsavedChangesGuard enabled />
      <p>Editor</p>
      <Link to="/elsewhere">Go elsewhere</Link>
    </>
  );
}

describe("UnsavedChangesGuard", () => {
  it("lets the operator cancel or explicitly continue an in-app navigation", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <Outlet />,
          children: [
            { path: "edit", element: <Editor /> },
            { path: "elsewhere", element: <p>Elsewhere</p> },
          ],
        },
      ],
      { initialEntries: ["/edit"] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("link", { name: "Go elsewhere" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByText("Editor")).toBeVisible();

    await user.click(screen.getByRole("link", { name: "Go elsewhere" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByText("Elsewhere")).toBeVisible();
  });
});
