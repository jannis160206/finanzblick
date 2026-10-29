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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const account = isAccountMode() ? await requireAccount() : undefined;
  const initial = account ? { state: createEmptyAccountState(), warning: undefined } : await getInitialData();
  return <>
    {!account && <script dangerouslySetInnerHTML={{ __html: seasonalThemeBootstrap }} />}
    <script dangerouslySetInnerHTML={{ __html: securityModeBootstrap }} />
    <SecurityModeProvider>
      <FinanceProvider key={account?.id ?? "local"} initialState={initial.state} account={account}>
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
