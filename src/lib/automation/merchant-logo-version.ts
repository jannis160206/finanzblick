import { createHash } from "node:crypto";
import {
  privateMerchantLogoSchema,
  type PrivateMerchantLogo,
} from "./merchant-logo-metadata";

export function merchantLogoVersion(logo: PrivateMerchantLogo): string {
  return createHash("sha256")
    .update(JSON.stringify(privateMerchantLogoSchema.parse(logo)))
    .digest("hex");
}
