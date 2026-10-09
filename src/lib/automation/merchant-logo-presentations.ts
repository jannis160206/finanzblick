import { merchantPresentations } from "./merchant-presentation";
import {
  merchantMarksRequestSchema,
  type MerchantPresentation,
} from "./merchant-presentation-schema";
import { logoAccountIdSchema } from "./merchant-logo-grant-metadata";
import { readAuthorizedMerchantLogo } from "./merchant-logo-grants";
import { AutomationStore } from "./store";
import { normalizeLogoIdentityName } from "./merchant-mark-name";

export async function accountMerchantPresentations(
  store: AutomationStore,
  input: unknown,
  userId: string,
): Promise<MerchantPresentation[]> {
  logoAccountIdSchema.parse(userId);
  const { merchantIds } = merchantMarksRequestSchema.parse(input);
  const privateCandidates = store.authorizedLogoCandidates(userId, merchantIds);
  const privateMarks = new Map<string, MerchantPresentation["logo"]>();
  const files = new Map<string, boolean>();
  for (const [merchantId, grants] of privateCandidates) {
    for (const grant of grants) {
      if (!files.has(grant.logo.file))
        files.set(
          grant.logo.file,
          !!(await readAuthorizedMerchantLogo(
            store.accounts.path,
            userId,
            grant.logo,
          )),
        );
      if (files.get(grant.logo.file)) {
        privateMarks.set(merchantId, {
          merchantId: grant.merchantId,
          version: grant.version,
        });
        break;
      }
    }
  }
  const publicMarks = await merchantPresentations(store, {
    merchantIds: [...new Set(merchantIds)].filter(
      (id) => !privateMarks.has(id),
    ),
  });
  const publicById = new Map(
    publicMarks.map((mark) => [mark.merchantId, mark.logo]),
  );
  return [...new Set(merchantIds)].map((merchantId) => ({
    merchantId,
    logo: privateMarks.get(merchantId) ?? publicById.get(merchantId) ?? null,
  }));
}

export async function accountMerchantNamePresentations(
  store: AutomationStore,
  names: string[],
  userId: string,
) {
  logoAccountIdSchema.parse(userId);
  const { merchantNames } = merchantMarksRequestSchema.parse({
    merchantIds: [],
    merchantNames: names,
  });
  const unique = [...new Set(merchantNames)];
  const wanted = new Set(unique.map(normalizeLogoIdentityName));
  const candidates = new Map<
    string,
    ReturnType<AutomationStore["loadMerchants"]>
  >();
  for (const merchant of store.loadMerchants()) {
    for (const alias of [merchant.canonicalName, ...merchant.aliases]) {
      const name = normalizeLogoIdentityName(alias);
      if (!wanted.has(name)) continue;
      const matches = candidates.get(name) ?? [];
      matches.push(merchant);
      candidates.set(name, matches);
    }
  }
  const identities = new Map<string, string>();
  for (const name of unique) {
    const matches = candidates.get(normalizeLogoIdentityName(name)) ?? [];
    const entities = new Set(
      matches.map((merchant) => merchant.wikidataId ?? `id:${merchant.id}`),
    );
    if (entities.size !== 1) continue;
    const merchant =
      matches.find((match) => match.source === "local") ?? matches[0];
    identities.set(name, merchant.id);
  }
  const marks = await accountMerchantPresentations(
    store,
    {
      merchantIds: [...new Set(identities.values())],
    },
    userId,
  );
  const byId = new Map(marks.map((mark) => [mark.merchantId, mark.logo]));
  return unique.map((merchantName) => ({
    merchantName,
    logo: byId.get(identities.get(merchantName) ?? "") ?? null,
  }));
}
