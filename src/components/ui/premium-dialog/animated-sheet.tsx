"use client";

import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { animate, useMotionValue, usePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { exitTween, sheetSpring, type MotionMode } from "./motion";

const DISMISS_VELOCITY = 600;
const RUBBER = 0.15;

type SheetSurfaceProps = ComponentPropsWithoutRef<"div"> & {
  mode: MotionMode;
  /** Visible heights as fractions of the viewport, ascending; without them the sheet fits its content. */
  snapPoints?: number[];
  /** Asks to close; returns false when closing is refused (e.g. unsaved draft). */
  onDismiss: () => boolean;
};

function useViewportHeight() {
  const [height, setHeight] = useState(() => (typeof window === "undefined" ? 800 : window.innerHeight));
  useEffect(() => {
    const update = () => setHeight(window.innerHeight);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return height;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T }).current = value;
}

/**
 * Bottom sheet surface: slides in, snaps to its heights, closes when swiped down; always reachable by keyboard.
 * Moving is a transform (GPU); the height changes only once at rest, so footer and actions stay on screen at every height.
 */
export const SheetSurface = forwardRef<HTMLDivElement, SheetSurfaceProps>(function SheetSurface(
  { mode, snapPoints, onDismiss, className, style, children, onPointerDown, ...props },
  forwarded,
) {
  const element = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback((node: HTMLDivElement | null) => {
    element.current = node;
    assignRef(forwarded, node);
  }, [forwarded]);
  const viewport = useViewportHeight();
  const pointsKey = snapPoints?.join(",") ?? "";
  const points = useMemo(() => (pointsKey ? pointsKey.split(",").map(Number).sort((a, b) => a - b) : undefined), [pointsKey]);
  const heights = useMemo(() => points?.map((point) => Math.round(point * viewport)), [points, viewport]);
  const [snap, setSnap] = useState(points ? points.length - 1 : 0);
  const y = useMotionValue(typeof window === "undefined" ? 1000 : window.innerHeight);
  const [isPresent, safeToRemove] = usePresence();
  const drag = useRef<{ start: number; origin: number; samples: { y: number; t: number }[] } | null>(null);
  const entered = useRef(false);
  const exiting = useRef(false);
  const busy = useRef(false);

  const height = () => element.current?.offsetHeight ?? 0;
  const run = useCallback((target: number, transition = sheetSpring) => {
    if (mode !== "full") { y.set(target); return Promise.resolve(); }
    return animate(y, target, transition).then(() => undefined);
  }, [mode, y]);

  useEffect(() => y.on("change", (value) => {
    if (element.current) element.current.style.transform = `translate3d(0, ${value}px, 0)`;
  }), [y]);

  // Slide in from below once the element has its size.
  useLayoutEffect(() => {
    if (entered.current) return;
    entered.current = true;
    if (mode === "full") { y.set(height() || window.innerHeight); void run(0); }
    else y.set(0);
  }, [mode, run, y]);

  // Reopened while still sliding out (AnimatePresence revives the same element): slide back in instead of staying off-screen.
  useEffect(() => {
    if (isPresent) {
      if (exiting.current) { exiting.current = false; void run(0); }
      return;
    }
    exiting.current = true;
    if (mode !== "full") { safeToRemove?.(); return; }
    void animate(y, height() + 24, exitTween).then(() => { if (exiting.current) safeToRemove?.(); });
  }, [isPresent, safeToRemove, mode, run, y]);

  // The on-screen keyboard shrinks the visual viewport; the sheet moves up with it.
  useEffect(() => {
    const visual = window.visualViewport;
    const node = element.current;
    if (!visual || !node) return;
    const update = () => node.style.setProperty("--sheet-keyboard", `${Math.max(0, window.innerHeight - visual.height - visual.offsetTop)}px`);
    update();
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, []);

  /** Moves to another height: shrinking slides first and then cuts the height, growing sets the height first and slides up. */
  const goToSnap = useCallback(async (next: number) => {
    if (!heights || busy.current) return;
    const current = heights[snap];
    const target = heights[next];
    busy.current = true;
    if (target < current) {
      await run(current - target);
      setSnap(next);
      y.set(0);
    } else {
      const offset = y.get() + (target - current);
      setSnap(next);
      y.set(offset);
      await run(0);
    }
    busy.current = false;
  }, [heights, snap, run, y]);

  function settle(velocity: number) {
    const offset = y.get();
    const visible = (heights ? heights[snap] : height()) - (offset + velocity * 0.12);
    const smallest = heights ? heights[0] : height();
    if (visible < smallest * 0.6 || (velocity > DISMISS_VELOCITY && offset > 12 && (!heights || snap === 0))) {
      if (onDismiss()) return;
    }
    if (!heights) { void run(0); return; }
    let best = 0;
    heights.forEach((value, index) => { if (Math.abs(value - visible) < Math.abs(heights[best] - visible)) best = index; });
    if (best === snap) void run(0);
    else void goToSnap(best);
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    onPointerDown?.(event);
    if (event.defaultPrevented || event.button !== 0 || busy.current) return;
    const target = event.target as HTMLElement;
    if (!target.closest("[data-sheet-drag]") || (target.closest("input, textarea, select, a, button") && !target.closest("[data-sheet-handle]"))) return;
    drag.current = { start: event.clientY, origin: y.get(), samples: [{ y: event.clientY, t: event.timeStamp }] };
    // A mouse drag must not start a text selection.
    if (event.pointerType === "mouse") event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    let next = state.origin + event.clientY - state.start;
    if (next < 0) next *= RUBBER;
    y.set(next);
    state.samples = [...state.samples.slice(-4), { y: event.clientY, t: event.timeStamp }];
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const first = state.samples[0];
    const last = state.samples.at(-1)!;
    if (Math.abs(event.clientY - state.start) < 4 && (event.target as HTMLElement).closest("[data-sheet-handle]")) { void run(0); return; }
    settle(((last.y - first.y) / Math.max(1, last.t - first.t)) * 1000);
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!heights) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = Math.max(0, Math.min(heights.length - 1, snap + (event.key === "ArrowUp" ? 1 : -1)));
      if (next !== snap) void goToSnap(next);
    }
  }

  return (
    <div
      ref={setRef}
      data-presentation="sheet"
      data-snap={heights ? snap : undefined}
      className={cn(
        "pointer-events-auto fixed inset-x-0 bottom-[var(--sheet-keyboard,0px)] z-50 flex max-h-[calc(100dvh-var(--sheet-keyboard,0px)-max(env(safe-area-inset-top),0.75rem))] flex-col overflow-hidden rounded-t-3xl border border-b-0 bg-card text-card-foreground shadow-overlay outline-none will-change-transform",
        className,
      )}
      style={{ ...style, ...(heights ? { height: heights[snap] } : {}), transform: `translate3d(0, ${y.get()}px, 0)` }}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      {...props}
    >
      <div data-sheet-drag className="flex shrink-0 touch-none justify-center pt-2 pb-1">
        {heights && heights.length > 1 ? (
          <button type="button" data-sheet-handle aria-label="Höhe anpassen" title="Höhe anpassen (Pfeil hoch/runter)"
            onKeyDown={handleKey} onClick={() => void goToSnap((snap + 1) % heights.length)}
            className="flex h-6 w-16 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-ring">
            <span aria-hidden="true" className="h-1.5 w-10 rounded-full bg-muted-foreground/35" />
          </button>
        ) : (
          <span aria-hidden="true" data-sheet-handle className="my-2 h-1.5 w-10 rounded-full bg-muted-foreground/35" />
        )}
      </div>
      {children}
    </div>
  );
});
