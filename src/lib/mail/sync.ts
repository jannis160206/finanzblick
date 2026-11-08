import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AccountDatabase } from "@/lib/server/database";
import type { AppState } from "@/lib/types";
import { AccountError } from "@/lib/server/errors";
import { GMAIL_QUERY, parseOrderMail, type ParsedCancel, type ParsedOrder } from "./orders";
import { reconcileOrders, type MailOrder } from "./reconcile";

const AUTO_SYNC_MS = 6 * 60 * 60 * 1000;
const FIRST_SYNC_DAYS = 60;
const MAX_MESSAGES = 300;
const MAX_PROCESSED = 4000;

const orderSchema = z.object({
  id: z.string().max(64), shop: z.string().max(100), product: z.string().max(100).optional(), orderNumber: z.string().max(60).optional(),
  amount: z.number(), orderDate: z.string(), dueDate: z.string(), method: z.enum(["card", "paypal", "klarna", "invoice", "unknown"]),
  installments: z.number().int().min(1).max(12), status: z.enum(["open", "paid", "cancelled", "expired", "dismissed"]),
  bookingId: z.string().max(200).optional(), planned: z.boolean().optional(), seen: z.string(),
});
const linkSchema = z.object({
  version: z.literal(1),
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  lastSync: z.number().optional(),
  lastError: z.string().max(500).optional(),
  processed: z.array(z.string().max(300)).default([]),
  orders: z.array(orderSchema).default([]),
});
type MailLink = z.infer<typeof linkSchema>;

export type MailOrderView = Pick<MailOrder, "id" | "shop" | "product" | "amount" | "orderDate" | "dueDate" | "method" | "installments" | "status">;
export type MailStatus = { connected: boolean; email?: string; lastSync?: number; lastError?: string; orders: MailOrderView[] };
export type MailSyncResult = MailStatus & { scanned: number; added: number; paid: number; cancelled: number };

const locks = new Map<string, Promise<unknown>>();
async function withUserLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(userId, next);
  try { return await next; } finally { if (locks.get(userId) === next) locks.delete(userId); }
}

const directory = (database: AccountDatabase) => join(dirname(database.path), "mail-links");
function linkPath(database: AccountDatabase, userId: string) {
  z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(userId);
  return join(directory(database), `${userId}.json`);
}

async function readLink(database: AccountDatabase, userId: string): Promise<MailLink | null> {
  try {
    const parsed = linkSchema.safeParse(JSON.parse(await readFile(linkPath(database, userId), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeLink(database: AccountDatabase, userId: string, link: MailLink): Promise<void> {
  const path = linkPath(database, userId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("Mail link directory must not be a symlink");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(linkSchema.parse(link)));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

const viennaDay = (value: Date | number) => new Date(value).toLocaleDateString("sv-SE", { timeZone: "Europe/Vienna" });

function statusOf(link: MailLink | null): MailStatus {
  if (!link) return { connected: false, orders: [] };
  const orders = link.orders.filter((order) => order.status === "open" || order.seen >= viennaDay(Date.now() - 30 * 86_400_000))
    .slice(0, 40).map(({ id, shop, product, amount, orderDate, dueDate, method, installments, status }) =>
      ({ id, shop, ...(product ? { product } : {}), amount, orderDate, dueDate, method, installments, status }));
  return { connected: true, email: link.email, ...(link.lastSync ? { lastSync: link.lastSync } : {}), ...(link.lastError ? { lastError: link.lastError } : {}), orders };
}

export async function mailStatus(database: AccountDatabase, userId: string): Promise<MailStatus> {
  return statusOf(await readLink(database, userId));
}

export type FetchedMail = { messageId: string; from: string; subject: string; text: string; date: string };
export type MailFetcher = (credentials: { email: string; password: string }, since: string) => Promise<FetchedMail[]>;

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? `${error.message} ${"responseText" in error ? String(error.responseText) : ""}` : "";
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|Application-specific password/i.test(raw))
    return "Gmail hat die Anmeldung abgelehnt. Bitte ein App-Passwort verwenden (nicht dein normales Passwort) und prüfen, ob IMAP aktiv ist.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout/i.test(raw)) return "Gmail ist gerade nicht erreichbar. Ich versuche es später erneut.";
  return "Die E-Mails konnten nicht gelesen werden.";
}

/** Read-only Gmail access over IMAP: searches shop/payment mails and never changes flags or deletes anything. */
export const gmailFetcher: MailFetcher = async ({ email, password }, since) => {
  const [{ ImapFlow }, { simpleParser }] = await Promise.all([import("imapflow"), import("mailparser")]);
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: email, pass: password }, logger: false,
    connectionTimeout: 20_000, socketTimeout: 60_000 });
  await client.connect();
  try {
    const all = (await client.list()).find((box) => box.specialUse === "\\All")?.path ?? "INBOX";
    const lock = await client.getMailboxLock(all, { readOnly: true });
    try {
      const uids = (await client.search({ gmraw: `${GMAIL_QUERY} after:${since.replace(/-/g, "/")}` }, { uid: true })) || [];
      const mails: FetchedMail[] = [];
      if (!uids.length) return mails;
      for await (const message of client.fetch(uids.slice(-MAX_MESSAGES), { uid: true, envelope: true, internalDate: true, source: { maxLength: 512_000 } }, { uid: true })) {
        if (!message.source) continue;
        const parsed = await simpleParser(message.source, { skipImageLinks: true, skipTextToHtml: true });
        const from = parsed.from?.value[0];
        const date = parsed.date ?? (message.internalDate ? new Date(message.internalDate) : new Date());
        mails.push({
          messageId: parsed.messageId ?? message.envelope?.messageId ?? `uid:${message.uid}`,
          from: from ? `${from.name ?? ""} <${from.address ?? ""}>` : "",
          subject: parsed.subject ?? "",
          text: (parsed.text ?? (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "")).replace(/[ \t]+/g, " "),
          date: viennaDay(date),
        });
      }
      return mails;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
};

export async function connectMail(database: AccountDatabase, userId: string, email: string, password: string, fetcher: MailFetcher = gmailFetcher): Promise<MailSyncResult> {
  const credentials = { email: email.trim().toLowerCase(), password: password.replace(/\s/g, "") };
  if (!/@(gmail|googlemail)\.com$/.test(credentials.email)) throw new AccountError(400, "Bitte eine Gmail-Adresse angeben.");
  try {
    await fetcher(credentials, viennaDay(Date.now()));
  } catch (error) {
    throw new AccountError(400, friendlyError(error));
  }
  await withUserLock(userId, async () => {
    const previous = await readLink(database, userId);
    await writeLink(database, userId, linkSchema.parse({ version: 1, ...credentials, processed: previous?.processed ?? [], orders: previous?.orders ?? [] }));
  });
  return syncMail(database, userId, fetcher);
}

export async function disconnectMail(database: AccountDatabase, userId: string): Promise<MailStatus> {
  return withUserLock(userId, async () => {
    const link = await readLink(database, userId);
    await unlink(linkPath(database, userId)).catch(() => undefined);
    if (link) applyToFinance(database, userId, (state) => reconcileOrders(state, link.orders.map((order) => order.status === "open" ? { ...order, status: "dismissed" as const } : order), [], viennaDay(Date.now())).state);
    return { connected: false, orders: [] };
  });
}

function applyToFinance(database: AccountDatabase, userId: string, change: (state: AppState) => AppState) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, revision } = database.getFinance(userId);
    if (!state) return;
    const next = change(state);
    if (next === state) return;
    try {
      database.putFinance(userId, next, revision);
      return;
    } catch {
      // A concurrent save won; retry on the fresh revision.
    }
  }
}

export async function syncMail(database: AccountDatabase, userId: string, fetcher: MailFetcher = gmailFetcher, now = Date.now()): Promise<MailSyncResult> {
  return withUserLock(userId, async () => {
    const link = await readLink(database, userId);
    if (!link) throw new AccountError(409, "Noch kein Gmail-Konto verbunden.");
    const today = viennaDay(now);
    const since = viennaDay(link.lastSync ? link.lastSync - 3 * 86_400_000 : now - FIRST_SYNC_DAYS * 86_400_000);
    let mails: FetchedMail[];
    try {
      mails = await fetcher(link, since);
    } catch (error) {
      const message = friendlyError(error);
      await writeLink(database, userId, { ...link, lastError: message });
      throw new AccountError(502, message);
    }
    const processed = new Set(link.processed);
    const fresh = mails.filter((mail) => !processed.has(mail.messageId));
    const parsed = fresh.map(parseOrderMail).filter((item): item is ParsedOrder | ParsedCancel => item !== undefined)
      .sort((a, b) => (a.kind === "order" ? a.orderDate : a.date).localeCompare(b.kind === "order" ? b.orderDate : b.date));
    let result: ReturnType<typeof reconcileOrders> | undefined;
    applyToFinance(database, userId, (state) => {
      result = reconcileOrders(state, link.orders, parsed, today);
      return result.state;
    });
    const summary = result ?? { orders: link.orders, added: 0, paid: 0, cancelled: 0 };
    const next: MailLink = { ...link, lastSync: now, processed: [...link.processed, ...fresh.map((mail) => mail.messageId)].slice(-MAX_PROCESSED), orders: summary.orders };
    delete next.lastError;
    await writeLink(database, userId, next);
    return { ...statusOf(next), scanned: fresh.length, added: summary.added, paid: summary.paid, cancelled: summary.cancelled };
  });
}

export async function linkedMailUsers(database: AccountDatabase): Promise<string[]> {
  try {
    return (await readdir(directory(database))).filter((name) => /^[A-Za-z0-9_-]{1,100}\.json$/.test(name)).map((name) => name.slice(0, -5));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function mailSyncDue(database: AccountDatabase, userId: string, now = Date.now()): Promise<boolean> {
  const link = await readLink(database, userId);
  return !!link && (!link.lastSync || now - link.lastSync >= AUTO_SYNC_MS);
}

/** Checks Gmail for new orders every 6 h while the statement worker runs. */
export function startMailAutoSync(database: AccountDatabase, signal: AbortSignal): void {
  let running = false;
  const tick = async () => {
    if (running || signal.aborted) return;
    running = true;
    try {
      for (const userId of await linkedMailUsers(database)) {
        if (signal.aborted) break;
        if (!(await mailSyncDue(database, userId))) continue;
        try {
          const result = await syncMail(database, userId);
          console.info(`Gmail: ${result.scanned} Mails geprüft, ${result.added} Bestellungen neu, ${result.paid} bezahlt.`);
        } catch (error) {
          console.warn("Gmail-Abruf fehlgeschlagen:", error instanceof Error ? error.message : "unbekannt");
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 15 * 60 * 1000);
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  setTimeout(() => void tick(), 45_000).unref();
}
