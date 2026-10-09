import { merchantPresentations } from "./merchant-presentation";
import {
  merchantMarksRequestSchema,
  type MerchantPresentation,
} from "./merchant-presentation-schema";
import { logoAccountIdSchema } from "./merchant-logo-grant-metadata";
import { readAuthorizedMerchantLogo } from "./merchant-logo-grants";
import { AutomationStore } from "./store";

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
