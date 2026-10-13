"use client";

import { useEffect, useRef, useState } from "react";
import { ZodError } from "zod";
import { FinanceStorageError } from "@/lib/finance-storage";
import { PayslipMutationError } from "@/lib/payslip-storage";

export function isPayslipMutationRejection(cause: unknown): cause is Error {
  return cause instanceof PayslipMutationError ||
    cause instanceof ZodError || cause instanceof FinanceStorageError;
}

// Finance update callbacks run in a reducer, not in the click handler.
export function usePayslipMutation<State>(
  state: State,
  update: (updater: (current: State) => State) => void,
) {
  const [attempt, setAttempt] = useState<{ complete: () => void } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    attempt?.complete();
  }, [attempt, state]);

  return (
    updater: (current: State) => State,
    onApplied: () => void,
    onRejected: (error: Error) => void,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    let outcome: { error?: Error } | undefined;
    let completed = false;
    const checked = (current: State) => {
      try {
        const next = updater(current);
        outcome = {};
        return next;
      } catch (cause) {
        if (!isPayslipMutationRejection(cause)) throw cause;
        outcome = { error: cause };
        return current;
      }
    };
    setAttempt({
      complete: () => {
        if (!outcome || completed) return;
        completed = true;
        inFlight.current = false;
        if (outcome.error) onRejected(outcome.error);
        else onApplied();
      },
    });
    try {
      update(checked);
    } catch (cause) {
      if (!isPayslipMutationRejection(cause)) {
        inFlight.current = false;
        throw cause;
      }
      outcome = { error: cause };
    }
  };
}
