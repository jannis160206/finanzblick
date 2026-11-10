"use client";

import { useEffect, useState, type RefObject } from "react";

/** A dialog body that overflows becomes a tab stop, so keyboard users can scroll content without controls. */
export function useScrollableFocus(ref: RefObject<HTMLElement | null>) {
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => setScrollable(node.scrollHeight - node.clientHeight > 1);
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    const mutation = new MutationObserver(measure);
    mutation.observe(node, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [ref]);
  return scrollable
    ? { tabIndex: 0, className: "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" }
    : { tabIndex: undefined, className: "" };
}
