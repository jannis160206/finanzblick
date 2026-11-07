"use client";

import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FinanceAssistant } from "@/components/finance-assistant";
import { useSecurityMode } from "@/components/security-mode-provider";
import { ASK_ASSISTANT_EVENT } from "@/lib/assistant-bus";

// The assistant is no separate page: a button on every page opens it as a side panel.
export function AssistantLauncher() {
  const security = useSecurityMode();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<{ text: string; at: number }>();
  useEffect(() => {
    const ask = (event: Event) => {
      const text = (event as CustomEvent<string>).detail ?? "";
      if (text) setPrompt({ text, at: Date.now() });
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
      aria-label="Finanz-Assistent öffnen" title="Finanz-Assistent"
      className="assistant-launcher fixed right-4 bottom-4 z-40 h-12 gap-2 rounded-full px-4 shadow-lg sm:right-6 sm:bottom-6">
      <MessageSquareText aria-hidden="true" className="size-5" /><span className="hidden sm:inline">Assistent</span>
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
