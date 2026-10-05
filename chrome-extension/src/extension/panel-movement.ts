interface PanelBounds {
  x: number;
  y: number;
  maxX: number;
  maxY: number;
  scaleX: number;
  scaleY: number;
}

interface PanelDrag {
  pointerId: number;
  clientX: number;
  clientY: number;
  x: number;
  y: number;
}

export function installPanelMovement(
  player: HTMLElement,
  panel: HTMLDivElement,
  handle: HTMLButtonElement,
): { refresh(): void; dispose(): void } {
  let disposed = false;
  let drag: PanelDrag | null = null;

  function bounds(): PanelBounds | null {
    if (panel.hidden) return null;
    const playerRect = player.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const width = player.clientWidth;
    const height = player.clientHeight;
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    if (
      ![
        width,
        height,
        panelWidth,
        panelHeight,
        playerRect.width,
        playerRect.height,
        panelRect.width,
        panelRect.height,
      ].every((value) => Number.isFinite(value) && value > 0)
    )
      return null;
    const scaleX = width / playerRect.width;
    const scaleY = height / playerRect.height;
    const x = (panelRect.left - playerRect.left) * scaleX;
    const y = (panelRect.top - playerRect.top) * scaleY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
      x,
      y,
      maxX: Math.max(width - panelWidth, 0),
      maxY: Math.max(height - panelHeight, 0),
      scaleX,
      scaleY,
    };
  }

  function position(x: number, y: number, measured: PanelBounds): void {
    x = Math.max(0, Math.min(x, measured.maxX));
    y = Math.max(0, Math.min(y, measured.maxY));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.dataset.positioned = "true";
    if (drag) {
      drag.x = x;
      drag.y = y;
    }
  }

  function refresh(): void {
    if (disposed) return;
    if (panel.hidden) {
      releaseDrag();
      return;
    }
    const measured = bounds();
    if (!measured) return;
    if (
      panel.dataset.positioned === "true" ||
      measured.x < 0 ||
      measured.y < 0 ||
      measured.x > measured.maxX ||
      measured.y > measured.maxY
    )
      position(measured.x, measured.y, measured);
  }

  function releaseDrag(): void {
    const pointerId = drag?.pointerId;
    drag = null;
    if (pointerId === undefined) return;
    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      // Capture may already have ended when the player or panel is removed.
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (disposed || drag || !event.isPrimary || event.button !== 0) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY))
      return;
    const measured = bounds();
    if (!measured) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    drag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: measured.x,
      y: measured.y,
    };
    position(measured.x, measured.y, measured);
  }

  function onPointerMove(event: PointerEvent): void {
    if (disposed || !drag || event.pointerId !== drag.pointerId) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY))
      return;
    const measured = bounds();
    if (!measured) return;
    event.preventDefault();
    event.stopPropagation();
    const x = drag.x + (event.clientX - drag.clientX) * measured.scaleX;
    const y = drag.y + (event.clientY - drag.clientY) * measured.scaleY;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    position(x, y, measured);
  }

  function onPointerEnd(event: PointerEvent): void {
    if (disposed || !drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    releaseDrag();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (disposed) return;
    if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      releaseDrag();
      for (const property of ["left", "top", "right", "bottom"])
        panel.style.removeProperty(property);
      delete panel.dataset.positioned;
      refresh();
      return;
    }
    const step = event.shiftKey ? 24 : 8;
    let dx = 0;
    let dy = 0;
    switch (event.key) {
      case "ArrowLeft":
        dx = -step;
        break;
      case "ArrowRight":
        dx = step;
        break;
      case "ArrowUp":
        dy = -step;
        break;
      case "ArrowDown":
        dy = step;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const measured = bounds();
    if (!measured) return;
    releaseDrag();
    position(measured.x + dx, measured.y + dy, measured);
  }

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerEnd);
  handle.addEventListener("pointercancel", onPointerEnd);
  handle.addEventListener("lostpointercapture", onPointerEnd);
  handle.addEventListener("keydown", onKeyDown);
  const observer = new ResizeObserver(refresh);
  observer.observe(player);
  observer.observe(panel);

  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseDrag();
      observer.disconnect();
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerEnd);
      handle.removeEventListener("pointercancel", onPointerEnd);
      handle.removeEventListener("lostpointercapture", onPointerEnd);
      handle.removeEventListener("keydown", onKeyDown);
    },
  };
}
