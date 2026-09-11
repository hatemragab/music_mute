import { useEffect, useRef } from "react";

export function useVisibleInterval(callback: () => void, milliseconds: number) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const run = () => {
      if (document.visibilityState === "visible") callbackRef.current();
    };
    const timer = window.setInterval(run, milliseconds);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [milliseconds]);
}
