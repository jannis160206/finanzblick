import { calculateDashboard } from "../src/lib/calc";
import { queueLedgerReview } from "../src/lib/import/review";
import { createSeed } from "../src/lib/seed";
import type { AppState, Transaction } from "../src/lib/types";

// Fully synthetic bookings: no private data is read. Run with `npm run benchmark:calculation`.
const SIZES = [500, 2_000, 10_000];
const RUNS = 5;
const BUDGET_MS: Record<number, { dashboard: number; review: number }> = {
  2_000: { dashboard: 300, review: 300 },
};
const merchants = ["Billa", "Spar", "Hofer", "Shell", "Netflix", "Restaurant Linde", "Amazon", "Apotheke", "Cafe Mitte", "Sakura"];
const categories = ["Lebensmittel", "Mobilität", "Restaurants", "Shopping", "Gesundheit", "Freizeit"] as const;

function synthetic(count: number): AppState {
  const state = createSeed();
  state.settings.asOf = "2026-09-16";
  state.settings.baselineDate = "2026-01-01";
  state.financeRows = [];
  state.transactions = Array.from({ length: count }, (_, index): Transaction => {
    const month = 1 + (index % 9);
    const day = 1 + (index % 27);
    return {
      id: `synthetic-${index}`,
      description: `${merchants[index % merchants.length]} Filiale ${index % 40} Wien`,
      date: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      amount: -(5 + (index % 90)),
      bank: "Revolut",
      pocket: null,
      category: categories[index % categories.length],
      categoryOverride: index % 2 === 0,
      includeInPlan: true,
      reviewed: true,
    };
  });
  return state;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
const time = (action: () => unknown) => {
  const start = performance.now();
  action();
  return performance.now() - start;
};
// An edit replaces exactly one booking object, like the app's immutable reducer does.
function edited(state: AppState, run: number): AppState {
  return { ...state, transactions: state.transactions.map((row, index) => index === 0 ? { ...row, description: `${row.description} ${run}` } : row) };
}

let exceeded = false;
console.log("bookings | cold dashboard | cold review | edit dashboard | edit review   (median ms of " + RUNS + " edits)");
for (const size of SIZES) {
  const state = synthetic(size);
  const coldDashboard = time(() => calculateDashboard(state));
  const coldReview = time(() => queueLedgerReview(state));
  const dashboard: number[] = [];
  const review: number[] = [];
  let current = state;
  for (let run = 1; run <= RUNS; run++) {
    current = edited(current, run);
    dashboard.push(time(() => calculateDashboard(current)));
    review.push(time(() => queueLedgerReview(current)));
  }
  const budget = BUDGET_MS[size];
  const editDashboard = median(dashboard);
  const editReview = median(review);
  const over = !!budget && (editDashboard > budget.dashboard || editReview > budget.review);
  if (over) exceeded = true;
  console.log(`${String(size).padStart(8)} | ${coldDashboard.toFixed(0).padStart(14)} | ${coldReview.toFixed(0).padStart(11)} | ${editDashboard.toFixed(0).padStart(14)} | ${editReview.toFixed(0).padStart(12)}${budget ? `  budget ${budget.dashboard}/${budget.review} ms ${over ? "EXCEEDED" : "ok"}` : ""}`);
}
if (exceeded) process.exitCode = 1;