import { calculateDashboard, type Dashboard } from "@/lib/calc";
import { addDays, contractChargesBetween, contractReminders, contractSummary, detectContracts, type ContractReminder, type ContractSummary } from "@/lib/contracts";
import { buildCopilotInsights, type CopilotInsight } from "@/lib/copilot-insights";
import { financeInsights, type FinanceInsights } from "@/lib/insights";
import { monthEndForecast, type MonthEndForecast } from "@/lib/month-forecast";
import { netWorthHistory, type NetWorthPoint } from "@/lib/net-worth";
import type { AppState } from "@/lib/types";

export type ContractsOverview = {
  summary: ContractSummary;
  upcoming: ReturnType<typeof contractChargesBetween>;
  reminder?: ContractReminder;
  empty: boolean;
};

/** Everything the dashboard cards derive from the whole ledger, computed in one pass (on a worker when possible). */
export type DashboardExtras = {
  insights: FinanceInsights;
  netWorth: NetWorthPoint[];
  contracts: ContractsOverview;
  forecast: MonthEndForecast;
  /** Proactive hints that were not dismissed, most important first. */
  copilot: CopilotInsight[];
};

export function computeDashboardExtras(state: AppState, dashboard: Dashboard = calculateDashboard(state)): DashboardExtras {
  const today = state.settings.asOf;
  const contracts = detectContracts(state, today);
  const reminder = contractReminders(contracts, today).find((item) => item.kind !== "missed");
  const forecast = monthEndForecast(state, dashboard, today, contracts);
  return {
    insights: financeInsights(state),
    netWorth: netWorthHistory(state, dashboard),
    contracts: {
      summary: contractSummary(contracts, today),
      upcoming: contractChargesBetween(contracts, today, addDays(today, 30), today).slice(0, 3),
      ...(reminder ? { reminder } : {}),
      empty: !contracts.some((contract) => contract.status !== "ignored"),
    },
    forecast,
    copilot: buildCopilotInsights(state, dashboard, today, { contracts, forecast }),
  };
}
