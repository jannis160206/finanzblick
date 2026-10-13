"use client";

import { createContext, useContext } from "react";
import type { AccountUser } from "@/lib/account-schema";

export type AccountWorkspace = {
  user: AccountUser;
  loadServer: () => Promise<void>;
  reconcileServer?: () => Promise<void>;
};
export const AccountWorkspaceContext = createContext<AccountWorkspace | null>(null);
export const useAccountWorkspace = () => useContext(AccountWorkspaceContext);
