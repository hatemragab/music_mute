import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { LibraryArtwork } from "./LibraryArtwork";

afterEach(cleanup);
const original = "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg";
const changed = "https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg";

test.each([undefined, null, "http://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg"])(
  "keeps the current music placeholder without requesting missing or invalid artwork: %s",
  (url) => {
    const { container } = render(<LibraryArtwork url={url} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".library-cover svg")).not.toBeNull();
  },
);

test("loads lazily without referrers, replaces the placeholder only when loaded, and restores it after failure", () => {
  const { container } = render(<LibraryArtwork url={original} />);
  const image = container.querySelector("img")!;
  expect(image).toHaveAttribute("src", original);
  expect(image).toHaveAttribute("loading", "lazy");
  expect(image).toHaveAttribute("decoding", "async");
  expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(image).toHaveAttribute("alt", "");
  expect(image).not.toHaveClass("loaded");
  expect(container.querySelector("svg")).not.toBeNull();
  fireEvent.load(image);
  expect(image).toHaveClass("loaded");
  expect(container.querySelector("svg")).toBeNull();
  fireEvent.error(image);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
});

test("a changed thumbnail retries loading while unchanged failed URLs stay on the placeholder", () => {
  const { container, rerender } = render(<LibraryArtwork url={original} />);
  fireEvent.error(container.querySelector("img")!);
  rerender(<LibraryArtwork url={original} />);
  expect(container.querySelector("img")).toBeNull();
  rerender(<LibraryArtwork url={changed} />);
  const image = container.querySelector("img")!;
  expect(image).toHaveAttribute("src", changed);
  expect(image).not.toHaveClass("loaded");
  expect(container.querySelector("svg")).not.toBeNull();
  fireEvent.load(image);
  expect(container.querySelector("svg")).toBeNull();
  rerender(<LibraryArtwork url={null} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
});

test("changing the track resets a failed image even when the returned URL is unchanged", () => {
  const { container, rerender } = render(
    <LibraryArtwork url={original} trackId="first" />,
  );
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toBeNull();
  rerender(<LibraryArtwork url={original} trackId="second" />);
  expect(container.querySelector("img")).toHaveAttribute("src", original);
  expect(container.querySelector("img")).not.toHaveClass("loaded");
});
