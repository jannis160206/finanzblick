import type { ReactNode } from "react";
import { FinanceProvider } from "@/components/finance-provider";
import { AppShell } from "@/components/app-shell";
import { AiReviewAssistant } from "@/components/ai-review-assistant";
import { SeasonalThemeProvider } from "@/components/seasonal-theme-provider";
import { SecurityModeProvider } from "@/components/security-mode-provider";
import { InteractionSoundsProvider } from "@/components/interaction-sounds";
import { seasonalThemeBootstrap } from "@/lib/seasonal-theme";
import { securityModeBootstrap } from "@/lib/security-mode";
import { getInitialData } from "@/lib/bootstrap";
import { createEmptyAccountState } from "@/lib/account-state";
import { isAccountMode, requireAccount } from "@/lib/server/auth";
import { serverFinanceSnapshot } from "@/lib/server/account-snapshot";
import { calculateDashboard } from "@/lib/calc";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const account = isAccountMode() ? await requireAccount() : undefined;
  // Rendering the stored account state on the server shows real figures with the first paint.
  const snapshot = account ? await serverFinanceSnapshot(account) : undefined;
  const initial = account ? { state: snapshot?.state ?? createEmptyAccountState(), warning: undefined } : await getInitialData();
  return <>
    {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static bootstrap script from our own constant, runs before paint */}
    {!account && <script dangerouslySetInnerHTML={{ __html: seasonalThemeBootstrap }} />}
    {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static bootstrap script from our own constant, runs before paint */}
    <script dangerouslySetInnerHTML={{ __html: securityModeBootstrap }} />
    <SecurityModeProvider>
      <FinanceProvider key={account?.id ?? "local"} initialState={initial.state} initialRevision={snapshot?.revision}
        initialDashboard={snapshot ? calculateDashboard(snapshot.state) : undefined} account={account}>
        <SeasonalThemeProvider>
          <InteractionSoundsProvider>
            <AppShell initialWarning={initial.warning}>{children}</AppShell>
          </InteractionSoundsProvider>
        </SeasonalThemeProvider>
        <AiReviewAssistant />
      </FinanceProvider>
    </SecurityModeProvider>
  </>;
}
