"use client";

import { createContext, useContext } from "react";
import type { AutomationJob, MerchantCatalogueStatus } from "@/lib/automation/schema";

export const AutomationContext = createContext<{
  jobs: AutomationJob[];
  error: string | null;
  catalogue?: MerchantCatalogueStatus;
}>({ jobs: [], error: null });
export const useAutomation = () => useContext(AutomationContext);
