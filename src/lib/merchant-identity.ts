import type { Transaction } from "@/lib/types";

type Identity = Partial<
  Pick<
    Transaction,
    "merchantAlias" | "merchantId" | "merchantLogo" | "merchantMatch"
  >
>;

export function merchantAliasAssignment(row: Identity, merchantAlias: string) {
  return {
    merchantAlias,
    ...(merchantAlias !== row.merchantAlias &&
    (row.merchantId || row.merchantLogo || row.merchantMatch)
      ? { merchantId: undefined, merchantLogo: false, merchantMatch: undefined }
      : {}),
  };
}
