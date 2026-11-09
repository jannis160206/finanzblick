"use client";

import type { ReactNode } from "react";
import { LazyMotion, MotionConfig } from "motion/react";

const loadFeatures = () => import("@/components/motion/motion-features").then((module) => module.default);

// Honours both the OS setting and the in-app "reduce motion" preference; animation features load after first paint.
export function MotionProvider({ reduced = false, children }: { reduced?: boolean; children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures}>
      <MotionConfig reducedMotion={reduced ? "always" : "user"}>{children}</MotionConfig>
    </LazyMotion>
  );
}
