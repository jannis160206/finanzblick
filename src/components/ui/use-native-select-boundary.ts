"use client";

import { useEffect } from "react";

let subscribers = 0;

function handleEscape(event: KeyboardEvent) {
  if (event.key === "Escape" && document.querySelector("select:open")) {
    // Let the browser close its picker before Radix dismisses the containing surface.
    event.stopPropagation();
  }
}

function handlePickerScroll(event: WheelEvent | TouchEvent) {
  const select = event.composedPath().find((target) => target instanceof HTMLSelectElement);
  if (select?.matches(":open") && CSS.supports("appearance", "base-select")) {
    // Radix's scroll lock cannot measure the browser's internal picker.
    // Keep its native scrolling without unlocking the surrounding dialog.
    event.stopPropagation();
  }
}

export function useNativeSelectBoundary() {
  useEffect(() => {
    if (typeof CSS === "undefined" || !CSS.supports("selector(select:open)")) return;
    if (subscribers++ === 0) {
      window.addEventListener("keydown", handleEscape, true);
      window.addEventListener("wheel", handlePickerScroll, { capture: true, passive: true });
      window.addEventListener("touchmove", handlePickerScroll, { capture: true, passive: true });
    }
    return () => {
      if (--subscribers === 0) {
        window.removeEventListener("keydown", handleEscape, true);
        window.removeEventListener("wheel", handlePickerScroll, true);
        window.removeEventListener("touchmove", handlePickerScroll, true);
      }
    };
  }, []);
}
