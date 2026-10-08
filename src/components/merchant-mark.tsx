"use client";

import { useState } from "react";
import type { classify } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { isMerchantTransfer } from "@/lib/merchant-transfer";
import type { Transaction } from "@/lib/types";
import { cn } from "@/lib/utils";

type MarkClassification = Pick<
  ReturnType<typeof classify>,
  "category" | "isTransfer"
>;

function initials(alias: string) {
  const words = alias.match(/[\p{L}\p{N}]+/gu) ?? [];
  return (
    words
      .slice(0, 2)
      .map((word) => [...word][0])
      .join("")
      .toLocaleUpperCase("de-AT") || "?"
  );
}

function LocalMerchantLogo({
  id,
  alias,
  fallback,
  className,
}: {
  id: string;
  alias?: string;
  fallback: string;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <span aria-hidden="true" className={className}>
        {fallback}
      </span>
    );
  const path = `/api/merchants/${encodeURIComponent(id)}`;
  return (
    <a
      href={`${path}/attribution`}
      target="_blank"
      rel="noopener noreferrer"
      title={`Lizenz/Herkunft${alias ? `: ${alias}` : ""}`}
      aria-label={`Logo-Lizenz und Quellenangabe${alias ? `: ${alias}` : ""}`}
      className={cn(
        className,
        "focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      {/* Authenticated local images must bypass the Next image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${path}/logo`}
        alt=""
        width={32}
        height={32}
        loading="lazy"
        decoding="async"
        className="size-8 object-contain"
        onError={() => setFailed(true)}
      />
    </a>
  );
}

export function MerchantMark({
  booking,
  classification,
  className,
}: {
  booking: Transaction;
  classification: MarkClassification;
  className?: string;
}) {
  const alias = booking.merchantAlias?.trim();
  if (
    classification.isTransfer ||
    isMerchantTransfer(booking) ||
    ["Kontoüberweisung", "Interne Umbuchung"].includes(booking.category) ||
    ["Kontoüberweisung", "Interne Umbuchung"].includes(
      classification.category,
    ) ||
    (!alias && isIncomeCategory(classification.category))
  )
    return null;

  const fallback = alias ? initials(alias) : "?";
  const markClassName = cn(
    "inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-xs font-semibold text-muted-foreground",
    className,
  );
  return booking.merchantLogo === true && booking.merchantId ? (
    <LocalMerchantLogo
      key={booking.merchantId}
      id={booking.merchantId}
      alias={alias}
      fallback={fallback}
      className={markClassName}
    />
  ) : (
    <span aria-hidden="true" className={markClassName}>
      {fallback}
    </span>
  );
}
