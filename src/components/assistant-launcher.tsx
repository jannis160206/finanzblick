"use client";

import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import { useSecurityMode } from "@/components/security-mode-provider";
import { ASK_ASSISTANT_EVENT, CLOSE_ASSISTANT_EVENT, assistantRequest } from "@/lib/assistant-bus";
import { useDashboardExtras } from "@/components/dashboard/use-dashboard-extras";
import { importantInsights } from "@/lib/copilot-insights";

const FinanceAssistant = dynamic(() => import("@/components/finance-assistant").then((module) => module.FinanceAssistant), {
  ssr: false,
  loading: () => (
    <div role="status" className="space-y-3 px-6 py-4">
      <span className="sr-only">Assistent wird geladen …</span>
      <Skeleton className="h-10 w-3/4" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-10 w-2/3" />
    </div>
  ),
});

// The assistant is no separate page: a button on every page opens it as a side panel.
export function AssistantLauncher() {
  const security = useSecurityMode();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<{ text: string; at: number; send?: boolean }>();
  const insights = useDashboardExtras()?.copilot;
  const hints = insights ? importantInsights(insights).length : 0;
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener(CLOSE_ASSISTANT_EVENT, close);
    return () => window.removeEventListener(CLOSE_ASSISTANT_EVENT, close);
  }, []);
  useEffect(() => {
    const ask = (event: Event) => {
      const request = assistantRequest((event as CustomEvent<unknown>).detail);
      if (request.text) setPrompt({ text: request.text, at: Date.now(), ...(request.send ? { send: true } : {}) });
      setOpen(true);
    };
    window.addEventListener(ASK_ASSISTANT_EVENT, ask);
    const url = new URL(window.location.href);
    if (url.searchParams.has("assistent")) {
      const text = url.searchParams.get("assistent")?.trim() ?? "";
      url.searchParams.delete("assistent");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      const timer = window.setTimeout(() => {
        if (text && text !== "1") setPrompt({ text: text.slice(0, 500), at: Date.now() });
        setOpen(true);
      }, 0);
      return () => { window.clearTimeout(timer); window.removeEventListener(ASK_ASSISTANT_EVENT, ask); };
    }
    return () => window.removeEventListener(ASK_ASSISTANT_EVENT, ask);
  }, []);
  return <>
    {!open && <Button type="button" onClick={() => setOpen(true)} disabled={!security.ready || security.locked}
      aria-label={hints ? `Finanz-Assistent öffnen, ${hints} ${hints === 1 ? "wichtiger Hinweis" : "wichtige Hinweise"}` : "Finanz-Assistent öffnen"} title="Finanz-Assistent"
      className="assistant-launcher fixed right-4 bottom-[calc(var(--shell-bottom-bar)+var(--safe-bottom)+0.75rem)] z-40 h-12 gap-2 rounded-full px-4 shadow-overlay md:right-6 md:bottom-6">
      <MessageSquareText aria-hidden="true" className="size-5" /><span className="hidden sm:inline">Assistent</span>
      {hints > 0 && !security.locked && <span aria-hidden="true" data-testid="assistant-hint-badge"
        className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-2xs font-semibold tabular-nums text-white ring-2 ring-background">
        {hints > 9 ? "9+" : hints}
      </span>}
    </Button>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent variant="panel" aria-describedby="assistant-panel-description">
        <DialogHeader className="pb-3 sm:pb-3">
          <DialogTitle>Finanz-Assistent</DialogTitle>
          <DialogDescription id="assistant-panel-description">Fragen, planen und ändern – die Zahlen rechnet der Code.</DialogDescription>
        </DialogHeader>
        <FinanceAssistant variant="panel" prompt={prompt} />
      </DialogContent>
    </Dialog>
  </>;
}
