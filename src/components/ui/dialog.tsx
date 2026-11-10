"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button, DialogFooterButtonContext } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogForm,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  useDialogState,
} from "@/components/ui/dialog-base"
import { PremiumDialogContent, usePremiumDialog, type PremiumDialogSize } from "@/components/ui/premium-dialog/premium-dialog"
import { useSecurityMode } from "@/components/security-mode-provider"
import { useNativeSelectBoundary } from "@/components/ui/use-native-select-boundary"

type DialogVariant = "default" | "confirmation" | "work" | "navigation" | "panel" | "command"

const premiumSize: Record<"default" | "confirmation" | "work", PremiumDialogSize> = { default: "md", confirmation: "sm", work: "xl" }
// Sizes a caller sets for the centered modal; a bottom sheet always spans the screen.
const modalOnly = /^(?:[a-z0-9-]+:)*(?:max-w|max-h|min-h|w|h)-/

/**
 * Input, confirmation and work dialogs open as the premium dialog (centered modal, bottom sheet below 768 px);
 * navigation, assistant panel and command palette stay drawers.
 */
function DialogContent({
  variant = "default",
  className,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, "forceMount"> & {
  showCloseButton?: boolean
  variant?: DialogVariant
}) {
  if (variant === "navigation" || variant === "panel" || variant === "command") {
    return <DrawerContent variant={variant} className={className} {...props} />
  }
  return <InputDialogContent variant={variant} className={className} {...props} />
}

function InputDialogContent({
  variant,
  className,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, "forceMount"> & {
  showCloseButton?: boolean
  variant: "default" | "confirmation" | "work"
}) {
  const sheetClass = className?.split(/\s+/).filter((token) => token && !modalOnly.test(token)).join(" ")
  return (
    <PremiumDialogContent
      size={premiumSize[variant]}
      variant={variant}
      snapPoints={variant === "work" ? [0.92] : undefined}
      className={className}
      sheetClassName={sheetClass || undefined}
      {...props}
    />
  )
}

function DrawerContent({
  className,
  children,
  showCloseButton = true,
  variant,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, "forceMount"> & {
  showCloseButton?: boolean
  variant: "navigation" | "panel" | "command"
}) {
  useNativeSelectBoundary()
  const { locked } = useSecurityMode()
  // Navigation and search stay usable in privacy mode; they render no financial data while locked.
  const privacySafe = variant === "navigation" || variant === "command"
  // Release modal focus/aria locks even when a background tab suspends exit animations.
  if (locked && !privacySafe) return null
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay financial={!privacySafe} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-variant={variant}
        className={cn(
          "fixed z-50 flex min-h-0 flex-col overflow-hidden border bg-card text-card-foreground shadow-overlay outline-none duration-200 ease-out motion-reduce:animate-none! data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          variant === "navigation"
            ? "inset-y-0 left-0 h-dvh w-[min(320px,calc(100vw-3rem))] rounded-r-2xl data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
            : variant === "panel"
            ? "inset-y-0 right-0 h-dvh w-[min(560px,100vw)] rounded-l-2xl data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
            : "top-3 left-1/2 max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-xl -translate-x-1/2 rounded-2xl data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:top-[12dvh]",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3 right-3 flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none sm:top-4 sm:right-4 [&_svg]:pointer-events-none [&_svg]:size-4"
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
  const { presentation } = usePremiumDialog()
  const sheet = presentation === "sheet"
  return (
    <div
      data-slot="dialog-header"
      data-sheet-drag={sheet ? "" : undefined}
      className={cn("shrink-0 space-y-2 p-6 pr-18 text-left sm:p-8 sm:pr-20", sheet && "touch-none pt-1 select-none sm:pt-1", className)}
      {...props}
    />
  )
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain p-6 sm:px-8", className)}
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
  const sheet = usePremiumDialog().presentation === "sheet"
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-col items-stretch justify-end gap-2 bg-muted/20 p-6 backdrop-blur-md sm:flex-row sm:flex-wrap sm:items-center sm:px-8",
        sheet && "pb-[calc(1.5rem+var(--safe-bottom,0px))]",
        className
      )}
      {...props}
    >
      <DialogFooterButtonContext.Provider value>
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close asChild>
            <Button variant="ghost">Schließen</Button>
          </DialogPrimitive.Close>
        )}
      </DialogFooterButtonContext.Provider>
    </div>
  )
}

export {
  useDialogState,
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
