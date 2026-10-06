import { redirect } from "next/navigation";
import { AccountForm } from "@/components/account-form";
import { getCurrentUser, isAccountMode, registrationEnabled } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export default async function RegisterPage() {
  if (!isAccountMode() || await getCurrentUser()) redirect("/");
  return <AccountForm mode="register" registrationEnabled={registrationEnabled()} />;
}
