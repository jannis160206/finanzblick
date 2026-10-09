"use client";

import { useState } from "react";
import {
  useMerchantLogoFailure,
  useMerchantMarks,
} from "@/components/merchant-marks-provider";
import type { classify } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { isMerchantTransfer } from "@/lib/merchant-transfer";
import type { Transaction } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  merchantLogoName,
  merchantNameMarkKey,
} from "@/lib/automation/merchant-mark-name";

type MarkClassification = Pick<
  ReturnType<typeof classify>,
  "category" | "isTransfer"
>;

export function shouldShowMerchantMark(
  booking: Transaction,
  classification: MarkClassification,
) {
  return !(
    classification.isTransfer ||
    isMerchantTransfer(booking) ||
    ["Kontoüberweisung", "Interne Umbuchung"].includes(booking.category) ||
    ["Kontoüberweisung", "Interne Umbuchung"].includes(
      classification.category,
    ) ||
    (!booking.merchantAlias?.trim() &&
      isIncomeCategory(classification.category))
  );
}

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
  version,
  alias,
  fallback,
  className,
  refreshVersion = 0,
}: {
  id: string;
  version?: string;
  alias?: string;
  fallback: string;
  className: string;
  refreshVersion?: number;
}) {
  const [failedVersion, setFailedVersion] = useState<number | null>(null);
  const reportFailure = useMerchantLogoFailure();
  if (failedVersion === refreshVersion)
    return (
      <span aria-hidden="true" className={className}>
        {fallback}
      </span>
    );
  const path = `/api/merchants/${encodeURIComponent(id)}`;
  const versionQuery = version ? `?v=${encodeURIComponent(version)}` : "";
  return (
    <a
      href={`${path}/attribution${versionQuery}`}
      target="_blank"
      rel="noopener noreferrer"
      title={`Lizenz/Herkunft${alias ? `: ${alias}` : ""}`}
      aria-label={`Logo-Lizenz und Quellenangabe${alias ? `: ${alias}` : ""}`}
      className={cn(
        className,
        "bg-white focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      {/* Authenticated local images must bypass the Next image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${path}/logo${versionQuery}`}
        alt=""
        width={32}
        height={32}
        loading="lazy"
        decoding="async"
        className="size-8 object-contain"
        onError={() => {
          setFailedVersion(refreshVersion);
          reportFailure?.();
        }}
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
  const marks = useMerchantMarks();
  const alias = booking.merchantAlias?.trim();
  if (!shouldShowMerchantMark(booking, classification)) return null;

  const fallback = alias ? initials(alias) : "?";
  const markClassName = cn(
    "inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-xs font-semibold text-muted-foreground",
    className,
  );
  const name = merchantLogoName(booking);
  const logo = booking.merchantId
    ? marks !== null
      ? marks.get(booking.merchantId)
      : booking.merchantLogo === true
        ? { merchantId: booking.merchantId, version: undefined }
        : null
    : name && marks !== null
      ? marks.get(merchantNameMarkKey(name))
      : null;
  return logo ? (
    <LocalMerchantLogo
      key={`${logo.merchantId}:${logo.version ?? ""}`}
      id={logo.merchantId}
      version={logo.version}
      refreshVersion={
        "refreshVersion" in logo ? logo.refreshVersion : undefined
      }
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
