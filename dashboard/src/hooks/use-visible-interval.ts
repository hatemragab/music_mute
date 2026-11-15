import { useEffect, useRef } from "react";

export function useVisibleInterval(
  callback: () => void,
  milliseconds: number,
  enabled = true,
) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;

    const run = () => {
      if (document.visibilityState === "visible") callbackRef.current();
    };
    const timer = window.setInterval(run, milliseconds);
    return () => {
      window.clearInterval(timer);
    };
  }, [enabled, milliseconds]);
}
