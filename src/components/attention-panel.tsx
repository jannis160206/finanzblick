"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowRight, CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { useAccountWorkspace } from "@/components/account-context";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { attentionItems, type AttentionItem } from "@/lib/attention";
import { localDateKey, readLastBackup, subscribeBackup } from "@/lib/backup-age";
import type { BankStatus } from "@/lib/banking/sync";
import { cn } from "@/lib/utils";

const icons = { bad: CircleAlert, warn: TriangleAlert, info: Info } as const;
const tones = {
  bad: "border-destructive/30 bg-destructive/5 text-destructive",
  warn: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  info: "border-border/70 bg-background/50 text-muted-foreground",
} as const;
const noBackupSnapshot = () => undefined;

async function loadBank(account: string): Promise<BankStatus | null> {
  const response = await fetch("/api/bank", { credentials: "same-origin", headers: { "X-Finanzblick-Account": account } });
  if (!response.ok) return null;
  const body = await response.json() as BankStatus;
  return body.configured && body.connections.length ? body : null;
}

/** "Zu erledigen": bank problems, open reviews, Amex top-up and backups in one place on the start page. */
export function AttentionPanel() {
  const { dashboard, ready, openReviewCount, syncNeedsAttention } = useFinance();
  const account = useAccountWorkspace()?.user.id ?? null;
  const scope = account ?? "local";
  const lastBackup = useSyncExternalStore(subscribeBackup, () => readLastBackup(scope), noBackupSnapshot);
  const [bank, setBank] = useState<BankStatus | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!account) return;
    let active = true;
    loadBank(account).then((status) => active && setBank(status), () => undefined);
    return () => { active = false; };
  }, [account]);

  const items = useMemo(() => attentionItems({
    now, today: localDateKey(), openReviews: openReviewCount, bank, amexToTransfer: dashboard.amex.additional,
    lastBackup, syncNeedsAttention,
  }), [now, openReviewCount, bank, dashboard.amex.additional, lastBackup, syncNeedsAttention]);

  if (!ready) return null;
  if (!items.length) return <p role="status" className="mb-5 flex items-center gap-2 text-xs text-muted-foreground">
    <CircleCheck aria-hidden="true" className="size-4 text-primary" />Nichts zu erledigen – Banken, Buchungen und Backup sind aktuell.
  </p>;
  return <section className="panel mb-5 p-4 sm:p-5" aria-label="Zu erledigen">
    <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
      Zu erledigen
      <span className="rounded-full bg-muted px-2 py-0.5 text-2xs tabular-nums text-muted-foreground">{items.length}</span>
    </h2>
    <ul className="grid gap-2 md:grid-cols-2">
      {items.map((item) => <AttentionRow key={item.id} item={item} />)}
    </ul>
  </section>;
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const Icon = icons[item.tone];
  return <li>
    <Link href={item.href} className={cn("group flex min-h-11 items-start gap-3 rounded-xl border p-3 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      tones[item.tone])} data-attention={item.id}>
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <FinancialData as="span" className="block text-sm font-medium text-foreground">{item.title}</FinancialData>
        {item.detail && <span className="mt-0.5 block text-xs text-muted-foreground">{item.detail}</span>}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 self-center text-xs font-medium text-primary">
        {item.action}<ArrowRight aria-hidden="true" className="size-3 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  </li>;
}
