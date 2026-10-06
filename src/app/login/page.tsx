import { redirect } from "next/navigation";
import { AccountForm } from "@/components/account-form";
import { getCurrentUser, isAccountMode, registrationEnabled } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ cache?: string | string[] }> }) {
  if (!isAccountMode() || await getCurrentUser()) redirect("/");
  const query = await searchParams;
  return <AccountForm mode="login" registrationEnabled={registrationEnabled()} storageWarning={query.cache === "unavailable"} />;
}
