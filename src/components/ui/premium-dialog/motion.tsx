"use client";

import { forwardRef, useSyncExternalStore, type ComponentPropsWithoutRef, type ElementType, type Ref } from "react";
import { m, type HTMLMotionProps, type Transition, type Variants } from "motion/react";

/** full: springs and stagger; reduced: short fades only; none: no animation, mount and unmount at once (tests). */
export type MotionMode = "full" | "reduced" | "none";

export const dialogSpring: Transition = { type: "spring", stiffness: 300, damping: 28, mass: 0.9 };
export const sheetSpring: Transition = { type: "spring", stiffness: 300, damping: 30, mass: 0.9 };
export const exitTween: Transition = { duration: 0.15, ease: [0.32, 0.72, 0, 1] };
const fade: Transition = { duration: 0.12, ease: "easeOut" };

const reducedQuery = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(reducedQuery);
  media.addEventListener?.("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
  return () => {
    media.removeEventListener?.("change", onChange);
    observer.disconnect();
  };
}

function snapshot(): MotionMode {
  if (process.env.NODE_ENV === "test" || typeof window.matchMedia !== "function") return "none";
  // The in-app setting counts like the system setting.
  if (document.documentElement.dataset.reduceMotion === "true" || window.matchMedia(reducedQuery).matches) return "reduced";
  return "full";
}

/** Whether dialogs animate at all; static per environment (never in tests), so it needs no subscription. */
export const motionAvailable = () =>
  process.env.NODE_ENV !== "test" && typeof window !== "undefined" && typeof window.matchMedia === "function";

export function useMotionMode(): MotionMode {
  return useSyncExternalStore(subscribe, snapshot, () => "none");
}

export function contentVariants(mode: MotionMode): Variants {
  if (mode !== "full") return { hidden: { opacity: 0 }, visible: { opacity: 1, transition: fade }, exit: { opacity: 0, transition: fade } };
  return {
    hidden: { opacity: 0, scale: 0.96, y: 8 },
    visible: { opacity: 1, scale: 1, y: 0, transition: { ...dialogSpring, staggerChildren: 0.035, delayChildren: 0.04 } },
    exit: { opacity: 0, scale: 0.98, y: 4, transition: exitTween },
  };
}

/** Wrapper inside a sheet: the sheet itself slides, its content only orchestrates the stagger. */
export function staggerVariants(mode: MotionMode): Variants {
  if (mode !== "full") return { hidden: {}, visible: {} };
  return { hidden: {}, visible: { transition: { staggerChildren: 0.035, delayChildren: 0.08 } } };
}

export function itemVariants(mode: MotionMode): Variants {
  if (mode !== "full") return { hidden: {}, visible: {} };
  return {
    hidden: { opacity: 0, y: 6 },
    visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 380, damping: 30 } },
  };
}

export function stepVariants(mode: MotionMode): Variants {
  if (mode !== "full") return {
    enter: { opacity: 0 }, center: { opacity: 1, transition: fade }, leave: { opacity: 0, transition: { duration: 0.08 } },
  };
  return {
    enter: (direction: number) => ({ opacity: 0, x: direction * 24 }),
    center: { opacity: 1, x: 0, transition: { ...dialogSpring, staggerChildren: 0.03 } },
    leave: (direction: number) => ({ opacity: 0, x: direction * -24, transition: { duration: 0.12, ease: [0.32, 0.72, 0, 1] } }),
  };
}

type MotionOnly = "initial" | "animate" | "exit" | "variants" | "transition" | "custom";
type BoxTag = "div" | "p" | "section" | "li" | "span";
type MotionBoxProps<T extends BoxTag> = { mode: MotionMode; as?: T } & Pick<HTMLMotionProps<T>, MotionOnly> &
  Omit<ComponentPropsWithoutRef<T>, MotionOnly | "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart">;

/** A motion element while animating, otherwise a plain element without any motion props. */
function MotionBoxInner<T extends BoxTag = "div">(
  { mode, as, initial, animate, exit, variants, transition, custom, ...rest }: MotionBoxProps<T>,
  ref: Ref<HTMLElement>,
) {
  const tag = (as ?? "div") as BoxTag;
  if (mode === "none") {
    const Tag = tag as ElementType;
    return <Tag ref={ref} {...rest} />;
  }
  const Component = m[tag] as ElementType;
  return <Component ref={ref} initial={initial} animate={animate} exit={exit} variants={variants} transition={transition} custom={custom} {...rest} />;
}

export const MotionBox = forwardRef(MotionBoxInner) as <T extends BoxTag = "div">(
  props: MotionBoxProps<T> & { ref?: Ref<HTMLElement> },
) => ReturnType<typeof MotionBoxInner>;
