"use client";

import { cn } from "@/lib/utils";

/** A native checkbox whose tick draws itself in. */
export function DrawnCheckbox({ checked, disabled, label, onChange }: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="grid size-5 shrink-0 place-items-center">
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="col-start-1 row-start-1 size-5 cursor-pointer appearance-none rounded-md border border-input bg-card transition-[background-color,border-color,scale] duration-150 ease-soft checked:border-primary checked:bg-primary active:scale-90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100" />
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"
        className="pointer-events-none col-start-1 row-start-1 size-3.5 text-primary-foreground">
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" pathLength={1}
          className={cn("[stroke-dasharray:1] transition-[stroke-dashoffset] ease-soft motion-reduce:transition-none",
            checked ? "[stroke-dashoffset:0] delay-75 duration-200" : "[stroke-dashoffset:1] duration-100")} />
      </svg>
    </span>
  );
}
