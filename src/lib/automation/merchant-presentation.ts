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
  files = new Map<string, Promise<boolean>>(),
): Promise<MerchantPresentation[]> {
  const { merchantIds } = merchantMarksRequestSchema.parse(input);
  const candidates = store.logoCandidates([...new Set(merchantIds)]);
  const result: MerchantPresentation[] = [];
  for (const [merchantId, references] of candidates) {
    let logo: MerchantPresentation["logo"] = null;
    for (const reference of references) {
      if (!reference.logo) continue;
      const file = reference.logo.file;
      if (!files.has(file))
        files.set(
          file,
          readPrivateMerchantLogo(store.accounts.path, reference.logo).then(
            (bytes) => !!bytes,
          ),
        );
      if (await files.get(file)) {
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
