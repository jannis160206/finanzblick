"use client";

import { Landmark } from "lucide-react";
import { useState } from "react";
import { bankColor, bankLogoUrl, bankMonogram } from "@/lib/banks/registry";
import { cn } from "@/lib/utils";

export type BankLogoSize = "xs" | "sm" | "md" | "lg";

const SIZES: Record<BankLogoSize, { box: string; radius: string; text: string; icon: string; pixels: number }> = {
  xs: { box: "size-4", radius: "rounded-md", text: "text-[0.5rem]", icon: "size-2.5", pixels: 16 },
  sm: { box: "size-6", radius: "rounded-md", text: "text-[0.625rem]", icon: "size-3.5", pixels: 24 },
  md: { box: "size-8", radius: "rounded-lg", text: "text-xs", icon: "size-4", pixels: 32 },
  lg: { box: "size-10", radius: "rounded-xl", text: "text-sm", icon: "size-5", pixels: 40 },
};

// A logo that failed once is not requested again by any other instance during this session.
const failedLogos = new Set<string>();

/** Bank mark: the monogram right away, the self-hosted logo on top once it has loaded. Decorative only. */
export function BankLogo({
  bank,
  country,
  size = "sm",
  className,
}: {
  bank: string | null | undefined;
  country?: string;
  size?: BankLogoSize;
  className?: string;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const name = bank?.trim() ?? "";
  const src = name ? bankLogoUrl(name, country) : "";
  const monogram = name ? bankMonogram(name, country) : "";
  const { box, radius, text, icon, pixels } = SIZES[size];
  const showImage = src !== "" && failedSrc !== src && !failedLogos.has(src);
  return (
    <span
      aria-hidden="true"
      data-bank-logo=""
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center font-semibold leading-none text-white ring-1 ring-inset ring-black/5 dark:ring-white/15",
        box,
        radius,
        text,
        className,
      )}
      style={{ backgroundColor: bankColor(name, country) }}
    >
      {monogram || <Landmark className={icon} strokeWidth={2.25} />}
      {showImage ? (
        // Same-origin, authenticated PNG: the Next image optimizer must not proxy it.
        // biome-ignore lint/performance/noImgElement: small local logo files, already sized; next/image would add a resize round trip
        <img
          src={src}
          alt=""
          width={pixels}
          height={pixels}
          loading="lazy"
          decoding="async"
          draggable={false}
          // An image that finished before hydration never fires onLoad.
          ref={(image) => {
            if (image?.complete && image.naturalWidth > 0) setLoadedSrc(src);
          }}
          onLoad={() => setLoadedSrc(src)}
          onError={() => {
            failedLogos.add(src);
            setFailedSrc(src);
          }}
          className={cn(
            "absolute inset-0 size-full bg-white object-contain p-[2px] ring-1 ring-black/5 transition-opacity duration-150 dark:ring-white/10",
            radius,
            loadedSrc === src ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
    </span>
  );
}
