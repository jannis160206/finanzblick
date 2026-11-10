"use client";

import {
  Cloud,
  Dumbbell,
  FileText,
  ShieldCheck,
  Smartphone,
  Tv,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { MerchantMark, shouldShowMerchantMark } from "@/components/merchant-mark";
import { useMerchantMarks } from "@/components/merchant-marks-provider";
import { merchantBookingMarkKey, merchantLogoBookingId, merchantLogoName, merchantNameMarkKey } from "@/lib/automation/merchant-mark-name";
import { classify } from "@/lib/calc";
import type { ContractType } from "@/lib/contract-types";
import type { Contract } from "@/lib/contracts";
import { cn } from "@/lib/utils";

export const contractTypeIcon: Record<ContractType, LucideIcon> = {
  streaming: Tv,
  mobile: Smartphone,
  internet: Wifi,
  insurance: ShieldCheck,
  energy: Zap,
  gym: Dumbbell,
  software: Cloud,
  other: FileText,
};

export const contractTypeLabel: Record<ContractType, string> = {
  streaming: "Streaming & Abos",
  mobile: "Handy",
  internet: "Internet",
  insurance: "Versicherungen",
  energy: "Strom & Gas",
  gym: "Fitness",
  software: "Software & Cloud",
  other: "Sonstige Verträge",
};

export const contractTypeTone: Record<ContractType, string> = {
  streaming: "bg-chart-1",
  mobile: "bg-chart-2",
  internet: "bg-chart-3",
  insurance: "bg-chart-4",
  energy: "bg-chart-5",
  gym: "bg-chart-6",
  software: "bg-chart-7",
  other: "bg-muted-foreground/50",
};

export const contractTypeOrder: ContractType[] = ["insurance", "energy", "internet", "mobile", "streaming", "software", "gym", "other"];

export function ContractMark({ contract, className }: { contract: Contract; className?: string }) {
  const marks = useMerchantMarks();
  const booking = contract.booking;
  if (booking) {
    const classification = classify(booking);
    const name = merchantLogoName(booking);
    const bookingId = merchantLogoBookingId(booking);
    // Without a known logo or alias the mark would only show "?"; the contract type says more.
    const known = !!booking.merchantAlias?.trim() || !!(marks && (
      (booking.merchantId && marks.get(booking.merchantId)) ||
      (name && marks.get(merchantNameMarkKey(name))) ||
      (bookingId && marks.get(merchantBookingMarkKey(bookingId)))));
    if (known && shouldShowMerchantMark(booking, classification)) {
      return <MerchantMark booking={booking} classification={classification} className={cn("size-10 rounded-xl", className)} />;
    }
  }
  const Icon = contractTypeIcon[contract.type];
  return (
    <span aria-hidden="true" className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground", className)}>
      <Icon className="size-4.5" />
    </span>
  );
}
