import type { BankStatus } from "@/lib/banking/sync";
import { backupStatus } from "@/lib/backup-age";
import { currency, dateLabel } from "@/lib/format";

export type AttentionItem = {
  id: string;
  tone: "bad" | "warn" | "info";
  title: string;
  detail?: string;
  href: string;
  action: string;
};

export type AttentionInput = {
  now: number;
  today: string;
  openReviews: number;
  bank?: Pick<BankStatus, "connections" | "accounts" | "lastSync" | "lastError"> | null;
  amexToTransfer?: number;
  lastBackup?: string | null;
  syncNeedsAttention?: boolean;
};

const DAY = 86_400_000;
const CONSENT_WARN_DAYS = 14;
// Bank data is fetched automatically every 6 hours; a day without a fetch means something is stuck.
const STALE_SYNC_MS = DAY;
const BANK_HREF = "/einstellungen#bankverbindung";
const rank = { bad: 0, warn: 1, info: 2 } as const;

// Daily PSD2 limits clear up on their own; a stuck fetch still shows up as "Bankabruf hängt" after a day.
const temporary = (message: string | null) => !!message && /tageslimit|rate.?limit|zu viele anfragen|429/i.test(message);
const bankName = (connection: BankStatus["connections"][number]) => connection.bankName?.trim() || "Bank";

function bankItems(bank: NonNullable<AttentionInput["bank"]>, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  const broken = new Set<string>();
  for (const connection of bank.connections) {
    const name = bankName(connection);
    const until = connection.consentValidUntil ? Date.parse(connection.consentValidUntil) : NaN;
    if (connection.syncActive === false || (Number.isFinite(until) && until <= now)) {
      broken.add(connection.id);
      items.push({ id: `bank-expired-${connection.id}`, tone: "bad", title: `${name}: Freigabe abgelaufen`,
        detail: "Neue Umsätze und Kontostände kommen erst nach dem Erneuern wieder.", href: BANK_HREF, action: "Freigabe erneuern" });
      continue;
    }
    if (connection.message && !temporary(connection.message)) {
      broken.add(connection.id);
      items.push({ id: `bank-message-${connection.id}`, tone: "warn", title: `${name}: Abruf unvollständig`, detail: connection.message.slice(0, 200),
        href: BANK_HREF, action: "Ansehen" });
      continue;
    }
    const days = Number.isFinite(until) ? Math.ceil((until - now) / DAY) : Infinity;
    if (days <= CONSENT_WARN_DAYS)
      items.push({ id: `bank-consent-${connection.id}`, tone: "warn", title: `${name}: Freigabe endet ${days <= 1 ? "morgen" : `in ${days} Tagen`}`,
        detail: `Gültig bis ${dateLabel(new Date(until).toISOString().slice(0, 10))}. Rechtzeitig erneuern, damit kein Abruf fehlt.`, href: BANK_HREF, action: "Freigabe erneuern" });
  }
  const failing = bank.accounts.filter((account) => account.syncError && !temporary(account.syncError) && !(account.connectionId && broken.has(account.connectionId)));
  if (failing.length) {
    const banks = [...new Set(failing.map((account) => account.bank))];
    items.push({ id: "bank-accounts", tone: "warn", title: `${failing.length === 1 ? "1 Konto" : `${failing.length} Konten`} nicht abgerufen`,
      detail: `${banks.join(", ")}: ${failing[0].syncError!.slice(0, 160)}`, href: BANK_HREF, action: "Ansehen" });
  }
  const active = bank.connections.some((connection) => !broken.has(connection.id));
  if (active && bank.lastSync && now - bank.lastSync > STALE_SYNC_MS) {
    const hours = Math.floor((now - bank.lastSync) / 3_600_000);
    items.push({ id: "bank-stale", tone: "warn", title: "Bankabruf hängt",
      detail: `Letzter Abruf vor ${hours >= 48 ? `${Math.floor(hours / 24)} Tagen` : `${hours} Stunden`}, sonst alle 6 Stunden.`, href: BANK_HREF, action: "Jetzt abrufen" });
  } else if (bank.lastError && !temporary(bank.lastError) && !items.length)
    items.push({ id: "bank-error", tone: "warn", title: "Letzter Bankabruf fehlgeschlagen", detail: bank.lastError.slice(0, 200), href: BANK_HREF, action: "Ansehen" });
  return items;
}

/** Everything on the start page that needs a click from the user, most urgent first. */
export function attentionItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (input.syncNeedsAttention)
    items.push({ id: "cloud-sync", tone: "bad", title: "Datenabgleich braucht dich", detail: "Gerät und Server haben unterschiedliche Stände.",
      href: "/einstellungen#sicherung", action: "Abgleichen" });
  if (input.bank) items.push(...bankItems(input.bank, input.now));
  if (input.openReviews > 0)
    items.push({ id: "reviews", tone: "warn", title: input.openReviews === 1 ? "1 Buchung prüfen" : `${input.openReviews} Buchungen prüfen`,
      detail: "Kategorie oder Zuordnung ist unsicher.", href: "/umsaetze?pruefen=1", action: "Prüfen" });
  if ((input.amexToTransfer ?? 0) >= 1)
    items.push({ id: "amex", tone: "warn", title: `${currency(input.amexToTransfer!)} auf Amex Rückzahlung legen`,
      detail: "Sonst reicht die Rücklage nicht für die nächste Amex-Abbuchung.", href: "/budget", action: "Ansehen" });
  if (input.lastBackup !== undefined) {
    const backup = backupStatus(input.lastBackup, input.today);
    if (backup.kind !== "recent")
      items.push({ id: "backup", tone: "info", title: backup.kind === "none" ? "Noch kein Excel-Backup" : `Excel-Backup ist ${backup.days} Tage alt`,
        detail: "Eine Kopie deiner Daten für den Notfall.", href: "/einstellungen#sicherung", action: "Sichern" });
  }
  return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
}
