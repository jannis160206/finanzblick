import { merchantPresentations } from "./merchant-presentation";
import {
  merchantMarksRequestSchema,
  type MerchantPresentation,
} from "./merchant-presentation-schema";
import { logoAccountIdSchema } from "./merchant-logo-grant-metadata";
import { AutomationStore } from "./store";
import {
  contractLogoIdentityName,
  normalizeLogoIdentityName,
} from "./merchant-mark-name";
import { normalizeLocalLogoName } from "./merchant-local-logos";
import { MerchantLogoRequest } from "./merchant-logo-request";

export async function accountMerchantPresentations(
  store: AutomationStore,
  input: unknown,
  userId: string,
  request = new MerchantLogoRequest(store, userId),
): Promise<MerchantPresentation[]> {
  logoAccountIdSchema.parse(userId);
  request.assertAccount(store, userId);
  const { merchantIds } = merchantMarksRequestSchema.parse(input);
  if (!merchantIds.length) return [];
  const privateCandidates = store.authorizedLogoCandidates(userId, merchantIds);
  const privateMarks = new Map<string, MerchantPresentation["logo"]>();
  const supplied = await request.localLogos();
  for (const merchantId of new Set(merchantIds)) {
    const merchant = store.getMerchant(merchantId);
    const named = (name: string) => {
      const grant = supplied.get(normalizeLocalLogoName(name));
      return grant ? [grant] : [];
    };
    let matches = [
      ...new Map(
        [...supplied.values()]
          .filter((grant) => grant.merchantId === merchantId)
          .concat(
            merchant
              ? [merchant.canonicalName, ...merchant.aliases].flatMap(named)
              : [],
          )
          .map((grant) => [grant.merchantId, grant]),
      ).values(),
    ];
    // Several supplied files (Amazon, AMZNPrime): the main name decides.
    if (matches.length > 1 && merchant) {
      const main = named(merchant.canonicalName);
      if (main.length) matches = main;
    }
    // "Uber Trip" shows the supplied brand logo "Uber".
    if (!matches.length && merchant) {
      const words = merchant.canonicalName.trim().split(/\s+/);
      for (let size = words.length - 1; size > 0 && !matches.length; size--) {
        const prefix = words.slice(0, size).join(" ");
        if ((prefix.match(/\p{L}/gu)?.length ?? 0) >= 3)
          matches = named(prefix);
      }
    }
    if (matches.length === 1)
      privateMarks.set(merchantId, {
        merchantId: matches[0].merchantId,
        version: matches[0].version,
      });
  }
  for (const [merchantId, grants] of privateCandidates) {
    if (privateMarks.has(merchantId)) continue;
    for (const grant of grants) {
      if (await request.privateLogoExists(grant.logo)) {
        privateMarks.set(merchantId, {
          merchantId: grant.merchantId,
          version: grant.version,
        });
        break;
      }
    }
  }
  const publicMarks = await merchantPresentations(
    store,
    {
      merchantIds: [...new Set(merchantIds)].filter(
        (id) => !privateMarks.has(id),
      ),
    },
    request.publicFiles,
  );
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
  request = new MerchantLogoRequest(store, userId),
) {
  logoAccountIdSchema.parse(userId);
  request.assertAccount(store, userId);
  const { merchantNames } = merchantMarksRequestSchema.parse({
    merchantIds: [],
    merchantNames: names,
  });
  const unique = [...new Set(merchantNames)];
  if (!unique.length) return [];
  const supplied = await request.localLogos();
  const local = new Map(
    unique.map((name) => [
      name,
      supplied.get(normalizeLocalLogoName(name)) ??
        supplied.get(normalizeLocalLogoName(contractLogoIdentityName(name))),
    ]),
  );
  const wanted = new Set(
    unique
      .filter((name) => !local.get(name))
      .map((name) => normalizeLogoIdentityName(contractLogoIdentityName(name))),
  );
  const candidates = new Map<
    string,
    ReturnType<AutomationStore["loadMerchants"]>
  >();
  for (const merchant of wanted.size ? request.merchants() : []) {
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
    if (local.get(name)) continue;
    const matches =
      candidates.get(
        normalizeLogoIdentityName(contractLogoIdentityName(name)),
      ) ?? [];
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
    request,
  );
  const byId = new Map(marks.map((mark) => [mark.merchantId, mark.logo]));
  return unique.map((merchantName) => {
    const grant = local.get(merchantName);
    return {
      merchantName,
      logo: grant
        ? { merchantId: grant.merchantId, version: grant.version }
        : (byId.get(identities.get(merchantName) ?? "") ?? null),
    };
  });
}
