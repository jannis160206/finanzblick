"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Dialog as DialogPrimitive } from "radix-ui"

import { useSecurityMode } from "@/components/security-mode-provider"

type DialogState = {
  /** Effective open state after the privacy lock. */
  open: boolean
  locked: boolean
  /** Closes like a dismissal (Escape, outside click), including the privacy-lock guard. */
  requestClose: () => void
}
const DialogStateContext = React.createContext<DialogState | null>(null)

function useDialogState() {
  return React.useContext(DialogStateContext)
}

function Dialog({
  open,
  defaultOpen = false,
  onOpenChange,
  allowWhenLocked = false,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & { allowWhenLocked?: boolean }) {
  const { locked } = useSecurityMode()
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
  const effectiveOpen = (allowWhenLocked || !locked) && (open ?? internalOpen)
  const change = (next: boolean) => {
    // CSS locks synchronously, before React updates the event closure.
    if (!allowWhenLocked && (locked || document.documentElement.dataset.securityMode === "locked")) return
    setInternalOpen(next); onOpenChange?.(next)
  }
  return <DialogPrimitive.Root
    data-slot="dialog"
    open={effectiveOpen}
    onOpenChange={change}
    {...props}
  >
    <DialogStateContext.Provider value={{ open: effectiveOpen, locked, requestClose: () => change(false) }}>{children}</DialogStateContext.Provider>
  </DialogPrimitive.Root>
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  financial = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay> & { financial?: boolean }) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      data-financial-overlay={financial ? "" : undefined}
      className={cn(
        "fixed inset-0 z-50 bg-black/50 backdrop-blur-md duration-200 ease-out motion-reduce:animate-none! data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogForm({ className, ...props }: React.ComponentProps<"form">) {
  return (
    <form
      data-slot="dialog-form"
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-xl leading-snug font-semibold tracking-tight", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  useDialogState,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogForm,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
