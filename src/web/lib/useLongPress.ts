import { useRef, type MouseEvent, type TouchEvent } from "react";

/**
 * Long-press on touch (iOS doesn't fire contextmenu) + right-click on desktop.
 * Suppresses the click that follows a long press so links don't navigate.
 */
export function useLongPress(callback: () => void, delay = 420) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };

  return {
    onTouchStart(e: TouchEvent) {
      fired.current = false;
      const t = e.touches[0];
      if (!t) return;
      start.current = { x: t.clientX, y: t.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        callback();
      }, delay);
    },
    onTouchMove(e: TouchEvent) {
      const t = e.touches[0];
      if (!start.current || !t) return;
      if (Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onContextMenu(e: MouseEvent) {
      e.preventDefault();
      if (fired.current) return; // already handled by the touch timer
      callback();
    },
    onClickCapture(e: MouseEvent) {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
  };
}
