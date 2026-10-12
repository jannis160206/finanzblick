import type { Transaction } from "@/lib/types";
import { merchantBookingIdSchema } from "./merchant-presentation-schema";
import { isAtmBooking } from "@/lib/atm-logo";

export const merchantNameMarkKey = (name: string) => `name:${name}`;

export function merchantLogoName(
  booking: Pick<Transaction, "merchantId" | "merchantAlias">,
) {
  if (booking.merchantId) return null;
  const name = booking.merchantAlias
    ?.trim()
    .replace(/\s+\|\s+Abo$/i, "")
    .trim();
  return name && name.length <= 100 && !/[\x00-\x1f\x7f]/.test(name)
    ? name
    : null;
}

export function normalizeLogoIdentityName(name: string) {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("de-AT")
    .replace(/\s+/g, " ")
    .trim();
}
export function merchantLogoBookingId(
  booking: Pick<
    Transaction,
    "id" | "merchantId" | "merchantAlias" | "merchantNameConfirmed"
  > &
    Partial<Pick<Transaction, "description" | "rawDescription" | "rawDetails">>,
) {
  if (
    !isAtmBooking(booking) &&
    (booking.merchantNameConfirmed ||
      (!booking.merchantId && booking.merchantAlias?.trim()))
  )
    return null;
  return merchantBookingIdSchema.safeParse(booking.id).success
    ? booking.id
    : null;
}

export function merchantBookingMarkKey(id: string) {
  return `booking:${id}`;
}
