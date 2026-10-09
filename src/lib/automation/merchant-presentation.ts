import { AutomationStore } from "./store";
import { readPrivateMerchantLogo } from "./merchant-logo";
import { merchantLogoVersion } from "./merchant-logo-version";
import {
  merchantMarksRequestSchema,
  type MerchantPresentation,
} from "./merchant-presentation-schema";

export async function merchantPresentations(
  store: AutomationStore,
  input: unknown,
): Promise<MerchantPresentation[]> {
  const { merchantIds } = merchantMarksRequestSchema.parse(input);
  const candidates = store.logoCandidates([...new Set(merchantIds)]);
  const files = new Map<string, boolean>();
  const result: MerchantPresentation[] = [];
  for (const [merchantId, references] of candidates) {
    let logo: MerchantPresentation["logo"] = null;
    for (const reference of references) {
      if (!reference.logo) continue;
      const file = reference.logo.file;
      if (!files.has(file))
        files.set(
          file,
          !!(await readPrivateMerchantLogo(
            store.accounts.path,
            reference.logo,
          )),
        );
      if (files.get(file)) {
        logo = {
          merchantId: reference.id,
          version: merchantLogoVersion(reference.logo),
        };
        break;
      }
    }
    result.push({ merchantId, logo });
  }
  return result;
}
