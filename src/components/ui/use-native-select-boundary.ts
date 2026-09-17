"use client";

import { useEffect } from "react";

export function useNativeSelectBoundary() {
  useEffect(() => {
    if (typeof CSS === "undefined" || !CSS.supports("selector(select:open)")) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && document.querySelector("select:open")) {
        // Let the browser close its picker before Radix dismisses the containing surface.
        event.stopPropagation();
      }
    }
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, []);
}
