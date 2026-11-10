"use client";

import { useDeferredValue, useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  CalendarDays,
  CornerDownLeft,
  FileUp,
  ListChecks,
  MessageSquareText,
  Moon,
  ReceiptText,
  Search,
  ShieldCheck,
  Sun,
  Tag,
  Target,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useFinance } from "@/components/finance-provider";
import { useSecurityMode } from "@/components/security-mode-provider";
import { useAccountWorkspace } from "@/components/account-context";
import { FinancialData } from "@/components/financial-data";
import { navigation } from "@/components/shell/navigation";
import { settingsGroups } from "@/components/settings-sections";
import { categories } from "@/lib/categories";
import { actualBookings, classify } from "@/lib/calc";
import { matchesTransactionSearch, normalizeSearch } from "@/lib/transaction-tools";
import { requestLedgerSearch } from "@/lib/ledger-search-bus";
import { askAssistant } from "@/lib/assistant-bus";
import { openImportDialog } from "@/lib/shell-events";
import { currency, dateLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Category } from "@/lib/types";

type SearchGroup = "Seiten" | "Einstellungen" | "Aktionen" | "Kategorien" | "Buchungen" | "Sparziele";

type SearchItem = {
  id: string;
  group: SearchGroup;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  amount?: number;
  run: () => void;
};

const groupOrder: SearchGroup[] = ["Seiten", "Aktionen", "Buchungen", "Kategorien", "Sparziele", "Einstellungen"];
const groupLimit: Record<SearchGroup, number> = { Seiten: 8, Aktionen: 6, Buchungen: 6, Kategorien: 5, Sparziele: 4, Einstellungen: 6 };

const subscribeNothing = () => () => {};

export function useShortcutLabel() {
  return useSyncExternalStore(
    subscribeNothing,
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Strg K"),
    () => "Strg K",
  );
}

function matches(item: Pick<SearchItem, "label" | "keywords" | "hint">, words: string[]) {
  if (!words.length) return true;
  const text = normalizeSearch(`${item.label} ${item.keywords ?? ""} ${item.hint ?? ""}`);
  return words.every((word) => text.includes(word));
}

function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function SearchTrigger({ onOpen, disabled }: { onOpen: () => void; disabled: boolean }) {
  const shortcut = useShortcutLabel();
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      className="inline-flex size-9 items-center justify-center gap-2.5 rounded-xl text-sm text-muted-foreground transition-[color,background-color,border-color,box-shadow] duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-11 md:h-10 md:w-full md:max-w-sm md:justify-start md:border md:border-border/80 md:bg-card md:px-3 md:shadow-xs md:hover:border-border md:hover:bg-card"
    >
      <Search aria-hidden="true" className="size-4 shrink-0" />
      <span className="sr-only md:not-sr-only md:flex-1 md:truncate md:text-left">Suchen …</span>
      <Kbd className="hidden md:inline-flex">{shortcut}</Kbd>
    </button>
  );
}

export function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { state, ready } = useFinance();
  const security = useSecurityMode();
  const workspace = useAccountWorkspace();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const inputId = useId();
  const listId = useId();
  const descriptionId = useId();
  const locked = security.locked;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (event.key === "/" && !open && !event.ctrlKey && !event.metaKey && !isEditable(event.target)) {
        event.preventDefault();
        onOpenChange(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const words = useMemo(() => normalizeSearch(deferredQuery).split(" ").filter(Boolean), [deferredQuery]);
  const trimmed = deferredQuery.trim();

  const ledger = useMemo(
    () => (open && ready && !locked && words.join("").length >= 2 ? actualBookings(state) : []),
    [open, ready, locked, words, state],
  );

  const items = useMemo(() => {
    if (!open) return [];
    const close = () => onOpenChange(false);
    const go = (href: string) => () => { close(); router.push(href); };
    const darkMode = (resolvedTheme ?? theme) === "dark";
    const statics: SearchItem[] = [
      ...navigation.map((item): SearchItem => ({ id: `page:${item.href}`, group: "Seiten", label: item.label, icon: item.icon, keywords: item.keywords, run: go(item.href) })),
      { id: "page:budget-jahr", group: "Seiten", label: "Budget · Jahresansicht", icon: CalendarDays, keywords: "jahresplan monate jahr", run: go("/budget?ansicht=jahr") },
      ...(!locked ? [{ id: "page:pruefen", group: "Seiten" as const, label: "Prüfliste öffnen", icon: ListChecks, keywords: "prüfen zuordnen offen review kategorie", run: go("/umsaetze?pruefen=1") }] : []),
      ...settingsGroups.flatMap((group) => group.items
        .filter((item) => !item.account || workspace)
        .map((item): SearchItem => ({
          id: `settings:${item.id}`,
          group: "Einstellungen",
          label: item.label,
          hint: group.label,
          icon: item.icon,
          keywords: item.keywords,
          run: () => {
            close();
            if (pathname === "/einstellungen") {
              window.history.replaceState(window.history.state, "", `#${item.id}`);
              // The settings page shows one category at a time and switches to the section's category on this event.
              window.dispatchEvent(new HashChangeEvent("hashchange"));
              document.getElementById(item.id)?.scrollIntoView?.({ block: "start" });
            } else router.push(`/einstellungen#${item.id}`);
          },
        }))),
      ...(!locked ? [{ id: "action:import", group: "Aktionen" as const, label: "Dateien importieren", icon: FileUp, keywords: "upload kontoauszug csv excel pdf lohnabrechnung hochladen", run: () => { close(); openImportDialog(); } }] : []),
      { id: "action:theme", group: "Aktionen", label: darkMode ? "Helles Farbschema" : "Dunkles Farbschema", icon: darkMode ? Sun : Moon, keywords: "farbschema dark mode hell dunkel theme", run: () => { setTheme(darkMode ? "light" : "dark"); close(); } },
      ...(security.preference !== "off" ? [{
        id: "action:security",
        group: "Aktionen" as const,
        label: locked ? "Finanzdaten anzeigen" : "Sichtschutz aktivieren",
        icon: ShieldCheck,
        keywords: "sicherheitsmodus sichtschutz verbergen unscharf privat",
        run: () => { close(); security.toggle(); },
      }] : []),
    ];
    const found = statics.filter((item) => matches(item, words) && (words.length || item.group !== "Einstellungen"));
    if (!locked && trimmed) {
      found.push({
        id: "action:ask",
        group: "Aktionen",
        label: `Assistent fragen: „${trimmed.slice(0, 60)}“`,
        icon: MessageSquareText,
        run: () => { close(); askAssistant(trimmed); },
      });
      for (const category of categories)
        if (matches({ label: category }, words))
          found.push({
            id: `category:${category}`,
            group: "Kategorien",
            label: category,
            hint: "Umsätze filtern",
            icon: Tag,
            run: () => { close(); requestLedgerSearch({ category: category as Category }); router.push("/umsaetze?month=all"); },
          });
      for (const goal of state.savingsGoals ?? [])
        if (matches({ label: goal.name, keywords: goal.pocket }, words))
          found.push({ id: `goal:${goal.id}`, group: "Sparziele", label: goal.name, hint: `Ziel ${currency(goal.target)}`, icon: Target, run: go("/sparen") });
      if (ledger.length) {
        const hits = ledger
          .filter((row) => !row.ignored && matchesTransactionSearch(row, trimmed))
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, groupLimit.Buchungen);
        for (const row of hits)
          found.push({
            id: `booking:${row.id}`,
            group: "Buchungen",
            label: row.merchantAlias || classify(row).merchant || row.description,
            hint: dateLabel(row.date),
            amount: row.amount,
            icon: ReceiptText,
            run: () => { close(); requestLedgerSearch({ query: trimmed }); router.push("/umsaetze?month=all"); },
          });
      }
    }
    return groupOrder.flatMap((group) => found.filter((item) => item.group === group).slice(0, groupLimit[group]));
  }, [open, words, trimmed, locked, workspace, pathname, router, onOpenChange, resolvedTheme, theme, setTheme, security, state.savingsGoals, ledger]);

  const selected = Math.min(active, Math.max(items.length - 1, 0));
  const activeItem = items[selected];

  useEffect(() => {
    if (!activeItem) return;
    document.getElementById(`${listId}-${activeItem.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeItem, listId]);

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((selected + step + items.length) % items.length);
    } else if (event.key === "Home" && event.ctrlKey) {
      setActive(0);
    } else if (event.key === "End" && event.ctrlKey) {
      setActive(items.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activeItem?.run();
    }
  }

  const grouped = groupOrder
    .map((group) => ({ group, entries: items.filter((item) => item.group === group) }))
    .filter((entry) => entry.entries.length);

  return (
    <Dialog
      open={open}
      allowWhenLocked
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) { setQuery(""); setActive(0); }
      }}
    >
      <DialogContent variant="command" showCloseButton={false} aria-describedby={descriptionId}>
        <DialogTitle className="sr-only">Suche</DialogTitle>
        <DialogDescription id={descriptionId} className="sr-only">
          {locked
            ? "Seiten, Einstellungen und Aktionen durchsuchen. Finanzdaten sind im Sichtschutz ausgeblendet."
            : "Seiten, Aktionen, Buchungen, Kategorien, Sparziele und Einstellungen durchsuchen."}
        </DialogDescription>
        <div className="flex items-center gap-3 border-b border-border/80 px-4">
          <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <input
            id={inputId}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? `${listId}-${activeItem.id}` : undefined}
            aria-label="Suchbegriff"
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder={locked ? "Seite oder Einstellung suchen …" : "Seite, Händler, Kategorie oder Aktion …"}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={onInputKeyDown}
            className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          <Kbd className="hidden sm:inline-flex">Esc</Kbd>
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Suchergebnisse"
          className="max-h-[min(26rem,calc(100dvh-12rem))] min-h-0 overflow-y-auto overscroll-contain p-2"
        >
          {grouped.map(({ group, entries }) => (
            <div key={group} role="group" aria-labelledby={`${listId}-${group}`} className="pb-1">
              <p id={`${listId}-${group}`} className="px-3 pt-2 pb-1 text-2xs font-medium text-muted-foreground">{group}</p>
              {entries.map((item) => {
                const index = items.indexOf(item);
                const isActive = index === selected;
                const content = (
                  <>
                    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", isActive ? "bg-card text-primary shadow-xs" : "bg-muted text-muted-foreground")}>
                      <item.icon aria-hidden="true" className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.label}</span>
                      {item.hint && <span className="block truncate text-2xs text-muted-foreground">{item.hint}</span>}
                    </span>
                    {item.amount !== undefined && (
                      <span className={cn("amount shrink-0 text-sm", item.amount > 0 && "text-money-in")}>{currency(item.amount)}</span>
                    )}
                    {isActive && <CornerDownLeft aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
                  </>
                );
                return (
                  <div
                    key={item.id}
                    id={`${listId}-${item.id}`}
                    role="option"
                    aria-selected={isActive}
                    onMouseMove={() => { if (!isActive) setActive(index); }}
                    onClick={() => item.run()}
                    className={cn("flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors duration-100", isActive ? "bg-accent" : "hover:bg-accent/60")}
                  >
                    {item.group === "Buchungen" || item.group === "Sparziele"
                      ? <FinancialData as="span" className="flex min-w-0 flex-1 items-center gap-3">{content}</FinancialData>
                      : content}
                  </div>
                );
              })}
            </div>
          ))}
          {!items.length && (
            <p role="status" className="px-3 py-10 text-center text-sm text-muted-foreground">
              Keine Treffer für „{trimmed}“.
            </p>
          )}
        </div>
        <div className="hidden items-center gap-4 border-t border-border/80 bg-surface-sunken px-4 py-2.5 text-2xs text-muted-foreground sm:flex">
          <span className="inline-flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> auswählen</span>
          <span className="inline-flex items-center gap-1"><Kbd>↵</Kbd> öffnen</span>
          <span className="inline-flex items-center gap-1"><Kbd>Esc</Kbd> schließen</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
