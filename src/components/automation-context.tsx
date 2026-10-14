"use client";

import { createContext, useContext } from "react";
import type { AutomationEvent, AutomationJob, MerchantCatalogueStatus } from "@/lib/automation/schema";

export const AutomationContext = createContext<{
  jobs: AutomationJob[];
  error: string | null;
  catalogue?: MerchantCatalogueStatus;
  worker?: AutomationEvent["worker"];
}>({ jobs: [], error: null });
export const useAutomation = () => useContext(AutomationContext);
