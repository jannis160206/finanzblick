"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { useSecurityMode } from "@/components/security-mode-provider"

function Dialog({
  open,
  defaultOpen = false,
  onOpenChange,
  allowWhenLocked = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & { allowWhenLocked?: boolean }) {
  const { locked } = useSecurityMode()
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
  return <DialogPrimitive.Root
    data-slot="dialog"
    open={(allowWhenLocked || !locked) && (open ?? internalOpen)}
    onOpenChange={(next) => { setInternalOpen(next); onOpenChange?.(next) }}
    {...props}
  />
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
        "fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  variant?: "default" | "confirmation" | "work" | "navigation"
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay financial={variant !== "navigation"} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-variant={variant}
        className={cn(
          "fixed z-50 flex min-h-0 flex-col overflow-hidden border bg-card text-card-foreground shadow-[0_24px_80px_-20px_rgb(0_0_0/0.35)] outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          variant === "navigation"
            ? "inset-y-0 left-0 h-dvh w-[min(320px,calc(100vw-3rem))] rounded-r-2xl data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
            : "top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1",
          variant === "default" && "max-w-xl",
          variant === "confirmation" && "max-w-md",
          variant === "work" && "max-w-4xl",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3 right-3 flex size-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none sm:top-4 sm:right-4 [&_svg]:pointer-events-none [&_svg]:size-4"
          >
            <XIcon />
            <span className="sr-only">Schließen</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("shrink-0 space-y-2 border-b p-4 pr-16 text-left sm:p-6 sm:pr-20", className)}
      {...props}
    />
  )
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6", className)}
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

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-muted/20 p-4 sm:px-6",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Schließen</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-snug font-semibold tracking-tight", className)}
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
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
