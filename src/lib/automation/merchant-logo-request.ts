import { createHash } from "node:crypto";
import { financeSnapshotSchema } from "@/lib/account-schema";
import { actualBookings } from "@/lib/calc";
import type { AccountDatabase } from "@/lib/server/database";
import type { Transaction } from "@/lib/types";
import { createAccountMerchantResolver } from "./aliases";
import { availableLocalLogoGrants } from "./merchant-local-logos";
import { syncLiveLogoDirectory } from "./merchant-live-logo-directory";
import { readAuthorizedMerchantLogo } from "./merchant-logo-grants";
import {
  logoAccountIdSchema,
  type AuthorizedMerchantLogo,
} from "./merchant-logo-grant-metadata";
import type { AutomationStore } from "./store";

const MAX_CACHED_ACCOUNTS = 2;
const MAX_CACHED_STATE_BYTES = 8 * 1024 * 1024;
type BookingLookup = {
  rows: ReadonlyMap<string, Transaction | null>;
  banks: string[];
  resolveAccount: ReturnType<typeof createAccountMerchantResolver>;
};
type CachedBookingLookup = { fingerprint: string; lookup: BookingLookup };
const bookingLookups = new WeakMap<
  AccountDatabase,
  Map<string, CachedBookingLookup>
>();

export class MerchantLogoRequest {
  readonly privateFiles = new Map<string, Promise<boolean>>();
  readonly publicFiles = new Map<string, Promise<boolean>>();
  private supplied?: ReturnType<typeof availableLocalLogoGrants>;
  private catalogue?: ReturnType<AutomationStore["loadMerchants"]>;

  constructor(
    readonly store: AutomationStore,
    readonly userId: string,
  ) {
    logoAccountIdSchema.parse(userId);
  }

  assertAccount(store: AutomationStore, userId: string) {
    if (store.accounts !== this.store.accounts || userId !== this.userId)
      throw new Error("Merchant logo request account mismatch");
  }

  localLogos() {
    return (this.supplied ??= syncLiveLogoDirectory(
      this.store,
      this.userId,
    ).then(() =>
      availableLocalLogoGrants(this.store, this.userId, this.privateFiles),
    ));
  }

  merchants() {
    return (this.catalogue ??= this.store.loadMerchants());
  }

  privateLogoExists(logo: AuthorizedMerchantLogo) {
    let available = this.privateFiles.get(logo.file);
    if (!available) {
      available = readAuthorizedMerchantLogo(
        this.store.accounts.path,
        this.userId,
        logo,
      ).then((bytes) => !!bytes);
      this.privateFiles.set(logo.file, available);
    }
    return available;
  }

  bookings(): BookingLookup | null {
    const row = this.store.accounts.read((db) =>
      db
        .prepare("SELECT state_json, revision FROM finance WHERE user_id = ?")
        .get(this.userId),
    );
    const cache: Map<string, CachedBookingLookup> =
      bookingLookups.get(this.store.accounts) ?? new Map();
    bookingLookups.set(this.store.accounts, cache);
    if (!row) {
      cache.delete(this.userId);
      return null;
    }
    if (typeof row.state_json !== "string")
      throw new Error("Invalid stored finance snapshot");
    const fingerprint = createHash("sha256")
      .update(row.state_json)
      .digest("hex");
    const previous = cache.get(this.userId);
    if (previous?.fingerprint === fingerprint) {
      cache.delete(this.userId);
      cache.set(this.userId, previous);
      return previous.lookup;
    }
    const { state } = financeSnapshotSchema.parse({
      state: JSON.parse(row.state_json),
      revision: row.revision,
    });
    if (!state) throw new Error("Invalid stored finance state");
    const rows = new Map<string, Transaction | null>();
    for (const booking of actualBookings(state))
      rows.set(booking.id, rows.has(booking.id) ? null : booking);
    const lookup = {
      rows,
      banks: [...new Set(state.transactions.map((booking) => booking.bank))],
      resolveAccount: createAccountMerchantResolver(state),
    };
    // Cache only derived, account-scoped lookup data, not snapshots or image
    // permissions. Hashing the stored state also detects external DB edits.
    cache.delete(this.userId);
    if (Buffer.byteLength(row.state_json) <= MAX_CACHED_STATE_BYTES) {
      cache.set(this.userId, { fingerprint, lookup });
      if (cache.size > MAX_CACHED_ACCOUNTS)
        cache.delete(cache.keys().next().value!);
    }
    return lookup;
  }
}
