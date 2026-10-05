import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPanelMovement } from "../src/extension/panel-movement";

class StyleFixture {
  left = "";
  top = "";
  right = "";
  bottom = "";
  removeProperty(property: string): string {
    const previous = this[property as "left" | "top" | "right" | "bottom"];
    this[property as "left" | "top" | "right" | "bottom"] = "";
    return previous;
  }
}

class ElementFixture extends EventTarget {
  clientWidth = 640;
  clientHeight = 360;
  offsetWidth = 200;
  offsetHeight = 100;
  hidden = false;
  dataset: Record<string, string> = {};
  style = new StyleFixture();
  left = 100;
  top = 80;
  scaleX = 1;
  scaleY = 1;
  anchorX = 16;
  anchorY = 196;
  player: ElementFixture | null = null;
  captured = new Set<number>();
  setPointerCapture = vi.fn((pointerId: number) => {
    this.captured.add(pointerId);
  });
  releasePointerCapture = vi.fn((pointerId: number) => {
    this.captured.delete(pointerId);
  });
  getBoundingClientRect(): DOMRect {
    const player = this.player;
    const x = player
      ? player.left +
        (this.style.left ? Number.parseFloat(this.style.left) : this.anchorX) *
          player.scaleX
      : this.left;
    const y = player
      ? player.top +
        (this.style.top ? Number.parseFloat(this.style.top) : this.anchorY) *
          player.scaleY
      : this.top;
    const width = this.hidden
      ? 0
      : player
        ? this.offsetWidth * player.scaleX
        : this.clientWidth * this.scaleX;
    const height = this.hidden
      ? 0
      : player
        ? this.offsetHeight * player.scaleY
        : this.clientHeight * this.scaleY;
    return {
      x,
      y,
      left: x,
      top: y,
      right: x + width,
      bottom: y + height,
      width,
      height,
      toJSON: () => ({}),
    };
  }
}

class ResizeFixture {
  static latest: ResizeFixture;
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(private callback: () => void) {
    ResizeFixture.latest = this;
  }
  resize(): void {
    this.callback();
  }
}

let player: ElementFixture;
let panel: ElementFixture;
let handle: ElementFixture;
let movement: ReturnType<typeof installPanelMovement>;

function pointer(
  type: string,
  values: Partial<{
    pointerId: number;
    clientX: number;
    clientY: number;
    button: number;
    isPrimary: boolean;
  }> = {},
): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    clientX: 130,
    clientY: 300,
    button: 0,
    isPrimary: true,
    ...values,
  });
  vi.spyOn(event, "stopPropagation");
  handle.dispatchEvent(event);
  return event;
}

function key(key: string, shiftKey = false): Event {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key,
    shiftKey,
  });
  vi.spyOn(event, "stopPropagation");
  handle.dispatchEvent(event);
  return event;
}

function position(x: number, y: number): void {
  expect(panel.style).toMatchObject({
    left: `${x}px`,
    top: `${y}px`,
    right: "auto",
    bottom: "auto",
  });
  expect(panel.dataset.positioned).toBe("true");
}

beforeEach(() => {
  player = new ElementFixture();
  panel = new ElementFixture();
  panel.player = player;
  handle = new ElementFixture();
  vi.stubGlobal("ResizeObserver", ResizeFixture);
  movement = installPanelMovement(
    player as unknown as HTMLElement,
    panel as unknown as HTMLDivElement,
    handle as unknown as HTMLButtonElement,
  );
});

afterEach(() => {
  movement.dispose();
  vi.unstubAllGlobals();
});

describe("panel pointer movement", () => {
  it("starts from the visible anchor and moves only the captured pointer", () => {
    const down = pointer("pointerdown");
    expect(down.defaultPrevented).toBe(true);
    expect(down.stopPropagation).toHaveBeenCalledOnce();
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    position(16, 196);
    pointer("pointermove", { pointerId: 2, clientX: 250, clientY: 340 });
    position(16, 196);
    const move = pointer("pointermove", { clientX: 250, clientY: 340 });
    expect(move.defaultPrevented).toBe(true);
    expect(move.stopPropagation).toHaveBeenCalledOnce();
    position(136, 236);
    pointer("pointerup");
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
    pointer("pointermove", { clientX: 300, clientY: 350 });
    position(136, 236);
  });

  it.each([{ button: 1 }, { button: 2 }, { isPrimary: false }])(
    "ignores a non-primary or non-left start",
    (values) => {
      const event = pointer("pointerdown", values);
      expect(event.defaultPrevented).toBe(false);
      expect(handle.setPointerCapture).not.toHaveBeenCalled();
      expect(panel.dataset.positioned).toBeUndefined();
    },
  );

  it("clamps all edges and keeps oversized panels at the origin", () => {
    pointer("pointerdown");
    pointer("pointermove", { clientX: -1000, clientY: -1000 });
    position(0, 0);
    pointer("pointermove", { clientX: 2000, clientY: 2000 });
    position(440, 260);
    player.clientWidth = 150;
    player.clientHeight = 70;
    pointer("pointermove", { clientX: 2010, clientY: 2010 });
    position(0, 0);
  });

  it("converts viewport movement and the visible origin into player CSS pixels", () => {
    player.scaleX = 2;
    player.scaleY = 0.5;
    pointer("pointerdown", { clientX: 150, clientY: 200 });
    position(16, 196);
    pointer("pointermove", { clientX: 190, clientY: 210 });
    position(36, 216);
  });

  it.each(["pointercancel", "lostpointercapture"])(
    "ends movement and releases capture after %s",
    (event) => {
      pointer("pointerdown");
      pointer(event, { pointerId: 2 });
      expect(handle.releasePointerCapture).not.toHaveBeenCalled();
      pointer(event);
      expect(handle.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
      pointer("pointermove", { clientX: 200, clientY: 350 });
      position(16, 196);
    },
  );

  it("ignores another start while one pointer owns movement", () => {
    pointer("pointerdown");
    pointer("pointerdown", { pointerId: 2 });
    expect(handle.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    pointer("pointermove", { clientX: 140, clientY: 310 });
    position(26, 206);
  });

  it("contains a capture acquisition failure without entering movement", () => {
    handle.setPointerCapture.mockImplementation(() => {
      throw new Error("Pointer is no longer active");
    });
    expect(() => pointer("pointerdown")).not.toThrow();
    pointer("pointermove", { clientX: 200, clientY: 350 });
    expect(panel.dataset.positioned).toBeUndefined();
    expect(handle.releasePointerCapture).not.toHaveBeenCalled();
  });

  it("ignores non-finite pointer coordinates without poisoning later movement", () => {
    pointer("pointerdown", { clientX: Number.NaN });
    expect(handle.setPointerCapture).not.toHaveBeenCalled();
    pointer("pointerdown");
    pointer("pointermove", { clientY: Number.POSITIVE_INFINITY });
    position(16, 196);
    pointer("pointermove", { clientX: 140, clientY: 310 });
    position(26, 206);
  });
});

describe("panel resize and visibility", () => {
  it("observes both dimensions and reclamps the position on player/panel resize", () => {
    expect(ResizeFixture.latest.observe.mock.calls).toEqual([
      [player],
      [panel],
    ]);
    pointer("pointerdown");
    pointer("pointermove", { clientX: 500, clientY: 500 });
    pointer("pointerup");
    position(386, 260);
    player.clientWidth = 300;
    player.clientHeight = 180;
    ResizeFixture.latest.resize();
    position(100, 80);
    panel.offsetWidth = 260;
    panel.offsetHeight = 160;
    ResizeFixture.latest.resize();
    position(40, 20);
  });

  it("preserves a fitting CSS anchor and can clamp an out-of-bounds anchor", () => {
    movement.refresh();
    expect(panel.dataset.positioned).toBeUndefined();
    player.clientHeight = 140;
    movement.refresh();
    position(16, 40);
  });

  it("skips a hidden panel and refreshes its prior manual position once shown", () => {
    pointer("pointerdown");
    pointer("pointerup");
    panel.hidden = true;
    player.clientWidth = 210;
    player.clientHeight = 120;
    ResizeFixture.latest.resize();
    movement.refresh();
    pointer("pointerdown");
    key("ArrowRight");
    position(16, 196);
    panel.hidden = false;
    movement.refresh();
    position(10, 20);
  });

  it("releases an active pointer when the panel is hidden without repositioning", () => {
    pointer("pointerdown");
    panel.hidden = true;
    movement.refresh();
    movement.refresh();
    expect(handle.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    position(16, 196);
    panel.hidden = false;
    pointer("pointermove", { clientX: 200, clientY: 340 });
    position(16, 196);
  });

  it.each([
    ["clientWidth", 0],
    ["clientHeight", 0],
    ["clientWidth", Number.NaN],
  ])("skips unknown player dimensions", (property, value) => {
    player[property as "clientWidth" | "clientHeight"] = value as number;
    movement.refresh();
    pointer("pointerdown");
    key("ArrowRight");
    expect(panel.dataset.positioned).toBeUndefined();
    expect(handle.setPointerCapture).not.toHaveBeenCalled();
  });

  it("skips unknown panel dimensions", () => {
    panel.offsetWidth = 0;
    movement.refresh();
    pointer("pointerdown");
    key("ArrowDown");
    expect(panel.dataset.positioned).toBeUndefined();
  });
});

describe("panel keyboard movement and cleanup", () => {
  it("moves arrows by eight CSS pixels and shifted arrows by twenty-four", () => {
    const right = key("ArrowRight");
    expect(right.defaultPrevented).toBe(true);
    expect(right.stopPropagation).toHaveBeenCalledOnce();
    position(24, 196);
    key("ArrowUp");
    position(24, 188);
    key("ArrowDown", true);
    position(24, 212);
    key("ArrowLeft", true);
    position(0, 212);
    key("ArrowLeft");
    position(0, 212);
    const other = key("Enter");
    expect(other.defaultPrevented).toBe(false);
    expect(other.stopPropagation).not.toHaveBeenCalled();
    position(0, 212);
  });

  it("resets all inline anchors with Home and ends any active capture", () => {
    pointer("pointerdown");
    pointer("pointermove", { clientX: 250, clientY: 320 });
    const home = key("Home");
    expect(home.defaultPrevented).toBe(true);
    expect(home.stopPropagation).toHaveBeenCalledOnce();
    expect(panel.style).toMatchObject({
      left: "",
      top: "",
      right: "",
      bottom: "",
    });
    expect(panel.dataset.positioned).toBeUndefined();
    expect(handle.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    movement.refresh();
    expect(panel.dataset.positioned).toBeUndefined();
    pointer("pointermove", { clientX: 300, clientY: 350 });
    expect(panel.dataset.positioned).toBeUndefined();
  });

  it("clamps a restored CSS anchor after the player shrinks while hidden", () => {
    key("ArrowRight");
    position(24, 196);
    panel.hidden = true;
    player.clientWidth = 210;
    player.clientHeight = 120;
    movement.refresh();
    position(24, 196);
    panel.hidden = false;
    key("Home");
    position(10, 20);
  });

  it("disposes during capture, removes listeners and ignores all later callbacks", () => {
    const remove = vi.spyOn(handle, "removeEventListener");
    pointer("pointerdown");
    movement.dispose();
    movement.dispose();
    expect(handle.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    expect(handle.captured.size).toBe(0);
    expect(ResizeFixture.latest.disconnect).toHaveBeenCalledOnce();
    expect(remove.mock.calls.map(([event]) => event)).toEqual([
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
      "lostpointercapture",
      "keydown",
    ]);
    pointer("pointermove", { clientX: 500, clientY: 500 });
    pointer("pointerdown");
    key("ArrowRight");
    key("Home");
    player.clientHeight = 120;
    ResizeFixture.latest.resize();
    movement.refresh();
    position(16, 196);
    expect(handle.setPointerCapture).toHaveBeenCalledOnce();
  });

  it("completes disposal even if capture release throws", () => {
    const remove = vi.spyOn(handle, "removeEventListener");
    pointer("pointerdown");
    handle.releasePointerCapture.mockImplementation(() => {
      throw new Error("Capture no longer exists");
    });
    expect(() => movement.dispose()).not.toThrow();
    expect(remove).toHaveBeenCalledTimes(6);
    expect(ResizeFixture.latest.disconnect).toHaveBeenCalledOnce();
    key("ArrowRight");
    position(16, 196);
  });
});
