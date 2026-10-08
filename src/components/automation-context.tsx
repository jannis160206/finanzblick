"use client";

import { createContext, useContext } from "react";
import type { AutomationJob } from "@/lib/automation/schema";

export const AutomationContext = createContext<{
  jobs: AutomationJob[];
  error: string | null;
}>({ jobs: [], error: null });
export const useAutomation = () => useContext(AutomationContext);
