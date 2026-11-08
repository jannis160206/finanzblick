import type { AppState, PlannedOneOff, Transaction } from "@/lib/types";
import { addDays, type ParsedCancel, type ParsedOrder, type PaymentMethod } from "./orders";

export type MailOrderStatus = "open" | "paid" | "cancelled" | "expired" | "dismissed";
export type MailOrder = Omit<ParsedOrder, "kind" | "bill"> & { status: MailOrderStatus; bookingId?: string; planned?: boolean; seen: string };

export const PLANNED_PREFIX = "mail-";
export const plannedId = (order: Pick<MailOrder, "id">) => `${PLANNED_PREFIX}${order.id}`;
const MAX_ORDERS = 500;
const cents = (value: number) => Math.round(value * 100);
const methodLabel: Record<PaymentMethod, string> = { card: "Karte", paypal: "PayPal", klarna: "Klarna", invoice: "Rechnung", unknown: "" };

export const plannedName = (order: Pick<MailOrder, "shop" | "product" | "method">) =>
  `${order.shop}${order.product ? ` · ${order.product}` : "-Bestellung"}${order.method === "klarna" || order.method === "invoice" ? ` (${methodLabel[order.method]})` : ""}`.slice(0, 100);

const firstRate = (order: MailOrder) => order.installments > 1 ? Math.floor(order.amount / order.installments * 100) / 100 : order.amount;
const words = (shop: string) => shop.toLowerCase().split(/[\s·.-]+/).filter((word) => word.length >= 3);
const bookingText = (row: Transaction) => [row.description, row.rawDescription, row.merchantAlias, ...(row.rawDetails ?? [])].join(" ").toLowerCase();

/** A real debit that pays the order: same amount (±2 % with the shop name, to the cent otherwise) close to the expected date. */
function findPayment(order: MailOrder, bookings: Transaction[], used: Set<string>): Transaction | undefined {
  const expected = firstRate(order);
  const from = addDays(order.orderDate, -2);
  const until = addDays(order.dueDate, 10);
  return bookings.find((row) => {
    if (used.has(row.id) || row.amount >= 0 || row.date < from || row.date > until) return false;
    const text = bookingText(row);
    const named = words(order.shop).some((word) => text.includes(word)) || (order.method === "klarna" && text.includes("klarna")) ||
      (order.method === "paypal" && text.includes("paypal"));
    const diff = Math.abs(cents(-row.amount) - cents(expected));
    return named ? diff <= Math.max(100, cents(expected) * 0.02) : diff === 0 && Math.abs(Date.parse(row.date) - Date.parse(order.dueDate)) <= 7 * 86_400_000;
  });
}

function sameOrder(left: Pick<MailOrder, "shop" | "amount" | "orderDate" | "orderNumber">, right: typeof left) {
  if (left.orderNumber && right.orderNumber) return left.orderNumber === right.orderNumber;
  return left.shop === right.shop && cents(left.amount) === cents(right.amount) && Math.abs(Date.parse(left.orderDate) - Date.parse(right.orderDate)) <= 86_400_000;
}

export type ReconcileResult = { state: AppState; orders: MailOrder[]; added: number; paid: number; cancelled: number };

/** Merges new mails into the order list, settles paid/cancelled/stale orders and mirrors open ones as planned payments. */
export function reconcileOrders(state: AppState, previous: MailOrder[], mails: Array<ParsedOrder | ParsedCancel>, today: string): ReconcileResult {
  const orders = previous.map((order) => ({ ...order }));
  let added = 0, paid = 0, cancelled = 0;
  const recurring = state.transactions.filter((row) => row.amount < 0 && row.fixedCost && row.date >= addDays(today, -120)).map(bookingText);
  for (const mail of mails.filter((item): item is ParsedOrder => item.kind === "order")) {
    if (orders.some((order) => order.id === mail.id || sameOrder(order, mail))) continue;
    // Monthly bills (phone, power, insurance) are already planned as fixed costs.
    if (mail.bill && recurring.some((text) => words(mail.shop).some((word) => text.includes(word)))) continue;
    const rest: Omit<MailOrder, "status" | "seen"> = { id: mail.id, shop: mail.shop, ...(mail.product ? { product: mail.product } : {}),
      ...(mail.orderNumber ? { orderNumber: mail.orderNumber } : {}), amount: mail.amount, orderDate: mail.orderDate, dueDate: mail.dueDate,
      method: mail.method, installments: mail.installments };
    orders.push({ ...rest, status: mail.dueDate < addDays(today, -21) ? "expired" : "open", seen: today });
    added += 1;
  }
  for (const cancel of mails.filter((item): item is ParsedCancel => item.kind === "cancel")) {
    const target = orders.find((order) => order.status === "open" && (cancel.orderNumber && order.orderNumber ? order.orderNumber === cancel.orderNumber
      : order.shop === cancel.shop && (cancel.amount === undefined || cents(cancel.amount) === cents(order.amount)) && order.orderDate <= cancel.date && order.orderDate >= addDays(cancel.date, -60)));
    if (target) { target.status = "cancelled"; cancelled += 1; }
  }
  const planned = new Map((state.plannedOneOffs ?? []).map((item) => [item.id, item]));
  const bookings = state.transactions.filter((row) => row.amount < 0).sort((a, b) => a.date.localeCompare(b.date));
  const used = new Set(orders.flatMap((order) => order.bookingId ? [order.bookingId] : []));
  for (const order of orders) {
    if (order.status !== "open") continue;
    if (order.planned && !planned.has(plannedId(order))) { order.status = "dismissed"; continue; }
    const payment = order.installments > 1 ? undefined : findPayment(order, bookings, used);
    if (payment) { order.status = "paid"; order.bookingId = payment.id; used.add(payment.id); paid += 1; continue; }
    const last = addDays(order.dueDate, (order.installments - 1) * 31);
    if (last < addDays(today, -21)) order.status = "expired";
  }
  const keep = (state.plannedOneOffs ?? []).filter((item) => !item.id.startsWith(PLANNED_PREFIX) ||
    orders.some((order) => order.status === "open" && plannedId(order) === item.id));
  const next: PlannedOneOff[] = keep.map((item) => {
    const order = orders.find((entry) => entry.status === "open" && plannedId(entry) === item.id);
    // An overdue single payment stays visible as "due tomorrow" until it is booked, cancelled or goes stale.
    return order && order.installments === 1 && item.date < today ? { ...item, date: addDays(today, 1) } : item;
  });
  for (const order of orders) {
    if (order.status !== "open" || next.some((item) => item.id === plannedId(order))) continue;
    if (next.length >= 500) break;
    const rate = firstRate(order);
    next.push({ id: plannedId(order), name: plannedName(order), date: order.installments === 1 && order.dueDate < today ? addDays(today, 1) : order.dueDate,
      amount: rate, pocket: "Giro", installments: order.installments, ...(order.installments > 1 ? { total: order.amount } : {}) });
    order.planned = true;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(state.plannedOneOffs ?? []);
  const trimmed = orders.sort((a, b) => b.orderDate.localeCompare(a.orderDate)).slice(0, MAX_ORDERS);
  return { state: changed ? { ...state, plannedOneOffs: next } : state, orders: trimmed, added, paid, cancelled };
}
