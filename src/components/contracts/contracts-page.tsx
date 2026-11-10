"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, CalendarClock, Check, ChevronRight, CircleHelp, EyeOff, FileText, Plus, Sparkles, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { PageHeading } from "@/components/finance-ui";
import { MerchantMarksProvider } from "@/components/merchant-marks-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ContractCancelDialog, ContractDetailDialog, type ContractAction, type ContractPatch } from "@/components/contracts/contract-dialogs";
import { ContractMark, contractTypeLabel, contractTypeOrder, contractTypeTone } from "@/components/contracts/contract-visuals";
import { askAssistant } from "@/lib/assistant-bus";
import { useAssistantPageContext, type AssistantPageContext } from "@/lib/assistant-context";
import { merchantLogoBookingId, merchantLogoName } from "@/lib/automation/merchant-mark-name";
import { round } from "@/lib/calc";
import {
  addDays,
  contractChargesBetween,
  contractPatch,
  contractReminders,
  contractSummary,
  daysBetween,
  detectContracts,
  intervalAdverb,
  intervalLabel,
  isRunning,
  upsertContractOverride,
  type Contract,
  type ContractReminder,
} from "@/lib/contracts";
import { currency, dateLabel } from "@/lib/format";
import type { AppState, ContractOverride } from "@/lib/types";
import { cn } from "@/lib/utils";

type View = "running" | "ended" | "ignored";

const editedKeys = ["name", "category", "amount", "interval", "nextDate", "notice", "termEnd", "autoRenew", "renewalMonths", "note"] as const;
const shortMonth = new Intl.DateTimeFormat("de-AT", { month: "short", timeZone: "UTC" });
const monthOf = (date: string) => shortMonth.format(new Date(`${date}T00:00:00Z`)).replace(".", "");

const ContractWizard = dynamic(() => import("@/components/contracts/contract-wizard"), { ssr: false });

function withOverride(state: AppState, id: string, entry: ContractOverride | undefined): AppState {
  const rest = (state.contracts ?? []).filter((item) => item.id !== id);
  return { ...state, contracts: entry ? [...rest, entry] : rest };
}

export function ContractsPage() {
  const { state, update, storageError, ready } = useFinance();
  const today = state.settings.asOf;
  const contracts = useMemo(() => detectContracts(state, today), [state, today]);
  const summary = useMemo(() => contractSummary(contracts, today), [contracts, today]);
  const reminders = useMemo(() => contractReminders(contracts, today), [contracts, today]);
  const upcoming = useMemo(() => contractChargesBetween(contracts, today, addDays(today, 30), today), [contracts, today]);
  const [view, setView] = useState<View>("running");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ contract: Contract | null; open: boolean; session: number } | null>(null);
  const [cancelling, setCancelling] = useState<Contract | null>(null);
  const disabled = !ready || !!storageError;
  const openEditor = (contract: Contract | null) => setEditing((current) => ({ contract, open: true, session: (current?.session ?? 0) + 1 }));
  const closeEditor = () => setEditing((current) => current && { ...current, open: false });
  const assistantContext = useMemo<AssistantPageContext>(() => ({ route: "/vertraege", title: "Verträge", ...(detailId ? { contractId: detailId } : {}) }), [detailId]);
  useAssistantPageContext(assistantContext);

  const review = contracts.filter((contract) => contract.status === "review");
  const running = contracts.filter((contract) => contract.status === "active" || (contract.status === "cancelled" && isRunning(contract, today)));
  const ended = contracts.filter((contract) => contract.status === "cancelled" && !isRunning(contract, today));
  const ignored = contracts.filter((contract) => contract.status === "ignored");
  const listed = view === "running" ? running : view === "ended" ? ended : ignored;
  const detail = contracts.find((contract) => contract.id === detailId) ?? null;
  const byType = contractTypeOrder.map((type) => ({
    type,
    items: running.filter((contract) => contract.type === type),
  })).filter((group) => group.items.length);
  const parts = byType.map(({ type, items }) => ({
    type,
    count: items.length,
    value: round(items.reduce((sum, contract) => sum + contract.monthly, 0)),
  }));
  const marks = useMemo(() => {
    const bookings = contracts.flatMap((contract) => contract.booking ? [contract.booking] : []);
    return {
      merchantIds: [...new Set(bookings.flatMap((booking) => booking.merchantId ? [booking.merchantId] : []))],
      merchantNames: [...new Set(bookings.flatMap((booking) => merchantLogoName(booking) ?? []))],
      bookingIds: [...new Set(bookings.flatMap((booking) => merchantLogoBookingId(booking) ?? []))],
    };
  }, [contracts]);

  function change(contract: Contract, patch: ContractPatch, message: string) {
    if (disabled) return;
    const previous = state.contracts?.find((entry) => entry.id === contract.id);
    update((current) => ({ ...current, contracts: upsertContractOverride(current.contracts, contract.id, contractPatch(contract, patch)) }));
    toast.success(message, {
      action: { label: "Rückgängig", onClick: () => update((current) => withOverride(current, contract.id, previous)) },
    });
  }

  function act(action: ContractAction, contract: Contract) {
    switch (action) {
      case "confirm": return change(contract, { status: "confirmed" }, `${contract.name} bestätigt`);
      case "ignore": setDetailId(null); return change(contract, { status: "ignored" }, `${contract.name} ausgeblendet`);
      case "restore": return change(contract, { status: undefined }, `${contract.name} wiederhergestellt`);
      case "reactivate": return change(contract, { status: "confirmed", cancelledAt: undefined }, `${contract.name} wieder aktiv`);
      case "reset": return change(contract, Object.fromEntries(editedKeys.map((key) => [key, undefined])), "Änderungen verworfen");
      case "cancel": return setCancelling(contract);
      case "edit": setDetailId(null); return openEditor(contract);
      case "prepare": setDetailId(null); return askAssistant(`Kündige ${contract.name}`);
      case "remove": {
        if (disabled) return;
        const previous = state.contracts?.find((entry) => entry.id === contract.id);
        setDetailId(null);
        update((current) => withOverride(current, contract.id, undefined));
        toast.success(`${contract.name} entfernt`, {
          action: { label: "Rückgängig", onClick: () => update((current) => withOverride(current, contract.id, previous)) },
        });
      }
    }
  }

  const empty = !contracts.length;
  return (
    <MerchantMarksProvider {...marks}>
      <PageHeading title="Verträge" description="Abos, Versicherungen und Fixkosten – erkannt aus deinen Abbuchungen.">
        <Button variant="outline" className="min-h-11" disabled={disabled} onClick={() => openEditor(null)}>
          <Plus aria-hidden="true" />Vertrag hinzufügen
        </Button>
      </PageHeading>

      {empty ? (
        <EmptyState icon={FileText} title="Noch keine Verträge erkannt" className="min-h-72">
          <p>Sobald ein Händler mehrmals im gleichen Rhythmus abbucht, erscheint er hier – Streaming, Handy, Versicherung oder Fitnessstudio.</p>
          <Button size="sm" variant="soft" className="mt-4" disabled={disabled} onClick={() => openEditor(null)}>
            <Plus aria-hidden="true" />Vertrag selbst anlegen
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <Card as="section" aria-labelledby="contracts-cost-title">
              <CardHeader>
                <CardTitle id="contracts-cost-title">Laufende Kosten</CardTitle>
                <CardDescription>{summary.active} {summary.active === 1 ? "Vertrag" : "Verträge"}{summary.review ? `, davon ${summary.review} noch zu prüfen` : ""}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-5 pt-3 pb-5 sm:pb-6">
                <FinancialData className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="amount text-4xl">{currency(summary.monthly)}</p>
                  <p className="text-sm text-muted-foreground">im Monat · {currency(summary.yearly)} im Jahr</p>
                </FinancialData>
                <CostBreakdown parts={parts} total={summary.monthly} />
              </CardContent>
            </Card>
            <UpcomingCharges upcoming={upcoming} onOpen={setDetailId} />
          </div>

          {reminders.length > 0 && <Reminders reminders={reminders} contracts={contracts} onOpen={setDetailId} onAction={act} />}

          {review.length > 0 && (
            <Card as="section" aria-labelledby="contracts-review-title">
              <CardHeader>
                <CardTitle id="contracts-review-title" className="flex items-center gap-2"><Sparkles aria-hidden="true" className="size-4 text-primary" />Neu erkannt</CardTitle>
                <CardDescription>Wiederkehrende Abbuchungen, die wie ein Vertrag aussehen. Passt das?</CardDescription>
              </CardHeader>
              <CardContent className="pb-3 sm:pb-4">
                <ul className="-mx-2 divide-y divide-border/60">
                  {review.map((contract) => (
                    <li key={contract.id} className="flex flex-col gap-2.5 px-2 py-3 sm:flex-row sm:items-center sm:gap-3">
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => setDetailId(contract.id)}>
                        <ContractMark contract={contract} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{contract.name}</span>
                          <FinancialData as="span" className="block text-xs text-muted-foreground">
                            {currency(contract.amount)} {intervalLabel[contract.interval]} · {contract.charges.length} Abbuchungen seit {dateLabel(contract.charges.at(-1)?.date ?? contract.lastDate ?? today)}
                          </FinancialData>
                        </span>
                      </button>
                      <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
                        <Button size="sm" variant="soft" disabled={disabled} onClick={() => act("confirm", contract)} aria-label={`${contract.name} als Vertrag bestätigen`}>
                          <Check aria-hidden="true" />Ist ein Vertrag
                        </Button>
                        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => act("ignore", contract)} aria-label={`${contract.name} ist kein Vertrag`}>
                          <EyeOff aria-hidden="true" />Kein Vertrag
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card as="section" aria-labelledby="contracts-list-title">
            <CardHeader className="gap-3 sm:flex sm:items-center sm:justify-between">
              <CardTitle id="contracts-list-title">Alle Verträge</CardTitle>
              <SegmentedControl<View> label="Verträge filtern" size="sm" value={view} onChange={setView} options={[
                { value: "running", label: `Laufend · ${running.length}` },
                { value: "ended", label: `Beendet · ${ended.length}` },
                { value: "ignored", label: `Ausgeblendet · ${ignored.length}` },
              ]} />
            </CardHeader>
            <CardContent className="pt-4 pb-3 sm:pb-4">
              {!listed.length ? (
                <EmptyState icon={FileText} title={view === "running" ? "Keine bestätigten Verträge" : view === "ended" ? "Keine beendeten Verträge" : "Nichts ausgeblendet"} className="min-h-40">
                  {view === "running" && review.length > 0 && <p>Bestätige oben die neu erkannten Abbuchungen.</p>}
                </EmptyState>
              ) : view === "running" ? (
                <div className="space-y-5">
                  {byType.map(({ type, items }) => (
                    <section key={type} aria-label={contractTypeLabel[type]}>
                      <FinancialData className="mb-1 flex items-baseline justify-between gap-3 px-1">
                        <h3 className="text-xs font-semibold text-muted-foreground">{contractTypeLabel[type]}</h3>
                        <span className="text-xs tabular-nums text-muted-foreground">{currency(round(items.reduce((sum, contract) => sum + contract.monthly, 0)))} / Monat</span>
                      </FinancialData>
                      <ContractList contracts={items} today={today} onOpen={setDetailId} />
                    </section>
                  ))}
                </div>
              ) : (
                <ContractList contracts={listed} today={today} onOpen={setDetailId} />
              )}
            </CardContent>
          </Card>
          <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
            <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            Erkannt wird, wer mindestens zwei- bis dreimal mit ähnlichem Betrag im gleichen Rhythmus abbucht. Kündigungsfristen kennt Finanzblick nur, wenn du sie einträgst.
          </p>
        </div>
      )}

      <ContractDetailDialog contract={detail} today={today} disabled={disabled} onClose={() => setDetailId(null)} onAction={act} />
      {editing && (
        <ContractWizard key={editing.session} open={editing.open} contract={editing.contract} contracts={contracts} state={state} today={today}
          disabled={disabled} storageError={storageError} onClose={closeEditor}
          onSave={(patch) => {
            const id = editing.contract?.id ?? `manual:${crypto.randomUUID()}`;
            update((current) => ({ ...current, contracts: upsertContractOverride(current.contracts, id, contractPatch(editing.contract, patch)) }));
            closeEditor();
            toast.success(editing.contract ? "Vertrag gespeichert" : "Vertrag hinzugefügt");
          }} />
      )}
      <ContractCancelDialog contract={cancelling} today={today} disabled={disabled} onClose={() => setCancelling(null)}
        onConfirm={(endDate) => {
          if (cancelling) change(cancelling, { status: "cancelled", cancelledAt: endDate }, `${cancelling.name} als gekündigt markiert`);
          setCancelling(null);
        }} />
    </MerchantMarksProvider>
  );
}

function CostBreakdown({ parts, total }: { parts: { type: Contract["type"]; count: number; value: number }[]; total: number }) {
  if (!parts.length) return null;
  const base = Math.max(total, 1);
  return (
    <FinancialData className="mt-auto space-y-3">
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {parts.map((part) => <div key={part.type} className={cn("h-full first:rounded-l-full last:rounded-r-full", contractTypeTone[part.type])} style={{ width: `${(part.value / base) * 100}%` }} />)}
      </div>
      <dl aria-label="Kosten nach Vertragsart" className="grid gap-y-2 text-sm">
        {parts.map((part) => (
          <div key={part.type} className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", contractTypeTone[part.type])} />
            <dt className="min-w-0 flex-1 truncate text-muted-foreground">{contractTypeLabel[part.type]} <span className="text-xs">· {part.count}</span></dt>
            <dd className="shrink-0 font-medium tabular-nums">{currency(part.value)}</dd>
          </div>
        ))}
      </dl>
    </FinancialData>
  );
}

function UpcomingCharges({ upcoming, onOpen }: { upcoming: ReturnType<typeof contractChargesBetween>; onOpen: (id: string) => void }) {
  const total = round(upcoming.reduce((sum, charge) => sum + charge.amount, 0));
  return (
    <Card as="section" aria-labelledby="contracts-upcoming-title">
      <CardHeader>
        <CardTitle id="contracts-upcoming-title">Nächste 30 Tage</CardTitle>
        <FinancialData as="p" className="text-xs text-muted-foreground">{upcoming.length ? `${upcoming.length} Abbuchungen · ${currency(total)}` : "Keine Abbuchungen geplant"}</FinancialData>
      </CardHeader>
      <CardContent className="pt-3 pb-3 sm:pb-4">
        {upcoming.length ? (
          <FinancialData as="ul" className="-mx-2">
            {upcoming.slice(0, 6).map(({ contract, date, amount }) => (
              <li key={`${contract.id}:${date}`}>
                <button type="button" onClick={() => onOpen(contract.id)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                  <span className="flex w-10 shrink-0 flex-col items-center rounded-lg bg-surface-sunken py-1 leading-none">
                    <span className="text-sm font-semibold tabular-nums">{Number(date.slice(8, 10))}</span>
                    <span className="mt-0.5 text-2xs text-muted-foreground">{monthOf(date)}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{contract.name}</span>
                  <span className="shrink-0 text-sm font-medium tabular-nums">{currency(-amount)}</span>
                </button>
              </li>
            ))}
          </FinancialData>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">In den nächsten 30 Tagen bucht kein Vertrag ab.</p>
        )}
        {upcoming.length > 6 && <p className="mt-1 px-1 text-xs text-muted-foreground">+ {upcoming.length - 6} weitere</p>}
      </CardContent>
    </Card>
  );
}

const reminderIcon = { deadline: CalendarClock, price: TrendingUp, missed: AlertTriangle } as const;

function Reminders({ reminders, contracts, onOpen, onAction }: {
  reminders: ContractReminder[];
  contracts: Contract[];
  onOpen: (id: string) => void;
  onAction: (action: ContractAction, contract: Contract) => void;
}) {
  return (
    <section aria-labelledby="contracts-reminders-title" className="space-y-2">
      <h2 id="contracts-reminders-title" className="px-1 text-sm font-semibold">Hinweise</h2>
      <ul className="grid gap-2 md:grid-cols-2">
        {reminders.slice(0, 6).map((reminder) => {
          const contract = contracts.find((item) => item.id === reminder.contractId);
          const Icon = reminderIcon[reminder.kind];
          return (
            <li key={reminder.id} className={cn("flex min-w-0 gap-3 rounded-2xl p-4",
              reminder.tone === "bad" ? "bg-destructive-soft" : reminder.tone === "warn" ? "bg-warning-soft" : "bg-info-soft")}>
              <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0",
                reminder.tone === "bad" ? "text-destructive" : reminder.tone === "warn" ? "text-warning" : "text-info")} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{reminder.title}</p>
                <FinancialData as="p" className="mt-0.5 text-xs leading-relaxed text-foreground/75">{reminder.body}</FinancialData>
                {contract && <div className="mt-2 -ml-2 flex flex-wrap gap-1">
                  {reminder.kind === "deadline" && <Button size="xs" variant="ghost" className="h-8 px-2 pointer-coarse:h-11" onClick={() => onAction("prepare", contract)}>Kündigung vorbereiten</Button>}
                  {reminder.kind === "missed" && <Button size="xs" variant="ghost" className="h-8 px-2 pointer-coarse:h-11" onClick={() => onAction("cancel", contract)}>Als gekündigt markieren</Button>}
                  <Button size="xs" variant="ghost" className="h-8 px-2 pointer-coarse:h-11" onClick={() => onOpen(contract.id)}>Details</Button>
                </div>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ContractList({ contracts, today, onOpen }: { contracts: Contract[]; today: string; onOpen: (id: string) => void }) {
  return (
    <ul className="-mx-2">
      {contracts.map((contract) => {
        const deadlineDays = contract.deadline ? daysBetween(today, contract.deadline) : null;
        const urgent = deadlineDays !== null && deadlineDays <= 30;
        const ended = contract.status === "cancelled";
        const nextText = ended
          ? contract.cancelledAt ? `${contract.cancelledAt > today ? "Endet" : "Beendet"} ${dateLabel(contract.cancelledAt)}` : "Gekündigt"
          : contract.nextDate ? dateLabel(contract.nextDate) : "–";
        return (
          <li key={contract.id}>
            <button type="button" onClick={() => onOpen(contract.id)}
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:grid-cols-[auto_minmax(0,1fr)_8.5rem_9.5rem_8rem_auto]">
              <ContractMark contract={contract} />
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={cn("truncate text-sm font-medium", contract.status === "ignored" && "text-muted-foreground")}>{contract.name}</span>
                  {contract.priceChange && contract.priceChange.percent > 0 && !ended && <Badge variant="warning" className="hidden sm:inline-flex"><TrendingUp aria-hidden="true" />{currency(contract.priceChange.to - contract.priceChange.from)}</Badge>}
                </span>
                <FinancialData as="span" className="block truncate text-xs text-muted-foreground">
                  <span className="md:hidden">{ended ? nextText : contract.nextDate ? `Nächste ${dateLabel(contract.nextDate)}` : intervalLabel[contract.interval]}</span>
                  <span className="hidden md:inline">{contract.category}{contract.account ? ` · ${contract.account}` : ""}</span>
                </FinancialData>
                {urgent && contract.deadline && <span className="mt-1 inline-flex md:hidden"><Badge variant={deadlineDays <= 7 ? "destructive" : "warning"}><CalendarClock aria-hidden="true" />Kündigen bis {dateLabel(contract.deadline)}</Badge></span>}
              </span>
              <FinancialData as="span" className="hidden text-sm tabular-nums text-muted-foreground md:block">{nextText}</FinancialData>
              <span className="hidden md:block">
                {contract.deadline
                  ? <Badge variant={urgent ? deadlineDays <= 7 ? "destructive" : "warning" : "secondary"}><CalendarClock aria-hidden="true" />bis {dateLabel(contract.deadline)}</Badge>
                  : <span className="text-xs text-muted-foreground">{contract.notice ? "–" : "Frist offen"}</span>}
              </span>
              <FinancialData as="span" className="text-right">
                <span className={cn("block text-sm font-semibold tabular-nums", ended && "text-muted-foreground line-through decoration-muted-foreground/50")}>{currency(contract.amount)}</span>
                <span className="block text-2xs text-muted-foreground">{intervalAdverb[contract.interval]}</span>
              </FinancialData>
              <ChevronRight aria-hidden="true" className="hidden size-4 text-muted-foreground md:block" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
