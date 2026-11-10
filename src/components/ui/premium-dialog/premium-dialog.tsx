"use client";

import { createContext, useContext, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { XIcon, type LucideIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button, DialogFooterButtonContext } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogForm, DialogTitle, DialogTrigger, useDialogState } from "@/components/ui/dialog-base";
import { useCompactLayout } from "@/components/ui/use-compact-layout";
import { useNativeSelectBoundary } from "@/components/ui/use-native-select-boundary";
import { useSecurityMode } from "@/components/security-mode-provider";
import { cn } from "@/lib/utils";
import { SheetSurface } from "./animated-sheet";
import { useScrollableFocus } from "./use-scrollable-focus";
import { MotionBox, contentVariants, exitTween, itemVariants, motionAvailable, staggerVariants, useMotionMode, type MotionMode } from "./motion";

export type PremiumDialogSize = "sm" | "md" | "lg" | "xl";
type Presentation = "modal" | "sheet";

type PremiumDialogContextValue = {
  mode: MotionMode;
  presentation: Presentation;
  stepped: boolean;
  setStepped: (stepped: boolean) => void;
};
const PremiumDialogContext = createContext<PremiumDialogContextValue | null>(null);

/** Motion mode and presentation of the surrounding premium dialog; outside one everything is static. */
export function usePremiumDialog(): PremiumDialogContextValue {
  return useContext(PremiumDialogContext) ?? { mode: "none", presentation: "modal", stepped: false, setStepped: () => {} };
}

// Step dialogs keep one height, so switching steps never resizes the dialog.
const stepHeights: Record<PremiumDialogSize, string> = {
  sm: "h-[min(88dvh,32rem)]",
  md: "h-[min(88dvh,34rem)]",
  lg: "h-[min(88dvh,38rem)]",
  xl: "h-[min(88dvh,42rem)]",
};

const sizes: Record<PremiumDialogSize, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-[44rem]",
  xl: "max-w-4xl",
};

type ContentProps = Omit<ComponentProps<typeof DialogPrimitive.Content>, "asChild" | "forceMount"> & {
  size?: PremiumDialogSize;
  /** auto: bottom sheet below 768 px, centered modal above. */
  presentation?: "auto" | Presentation;
  /** Sheet heights as fractions of the viewport (e.g. [0.55, 0.92]); without them the sheet fits its content. */
  snapPoints?: number[];
  /** Shown beside the content on wide screens (≥ 1024 px), e.g. a live preview. */
  preview?: ReactNode;
  /** Unsaved input: Escape, outside clicks and swiping ask before discarding. */
  dirty?: boolean;
  showCloseButton?: boolean;
  /** The overlay blurs financial data (privacy mode). */
  financial?: boolean;
  /** Kept on the element for styling hooks and tests (e.g. "confirmation"). */
  variant?: string;
  /** Classes for the bottom sheet instead of `className` (e.g. without modal widths). */
  sheetClassName?: string;
};

export function PremiumDialogContent({ presentation = "auto", ...props }: ContentProps) {
  const state = useDialogState();
  const { locked } = useSecurityMode();
  const open = state?.open ?? true;
  if (locked) return null;
  const presenter = <PremiumPresenter key="surface" presentation={presentation} requestClose={() => state?.requestClose()} {...props} />;
  if (!motionAvailable()) return open ? presenter : null;
  return <AnimatePresence>{open && presenter}</AnimatePresence>;
}

// Mounted only while open, so the many closed dialogs of a page never subscribe to media queries.
function PremiumPresenter({ presentation = "auto", sheetClassName, className, ...props }: ContentProps & { requestClose: () => void }) {
  useNativeSelectBoundary();
  const compact = useCompactLayout();
  const mode = useMotionMode();
  const kind: Presentation = presentation === "auto" ? (compact ? "sheet" : "modal") : presentation;
  return <PremiumSurface key={kind} kind={kind} mode={mode} className={kind === "sheet" ? sheetClassName ?? className : className} {...props} />;
}

function PremiumSurface({
  kind, mode, requestClose, size = "md", snapPoints, preview, dirty = false, showCloseButton = true, financial = true, variant = "premium",
  className, children, onEscapeKeyDown, onInteractOutside, onCloseAutoFocus, ...props
}: Omit<ContentProps, "presentation" | "sheetClassName"> & { kind: Presentation; mode: MotionMode; requestClose: () => void }) {
  const [stepped, setStepped] = useState(false);
  // Dialogs opened without a DialogTrigger still return focus to where the user was.
  const [returnTo] = useState(() => (typeof document === "undefined" ? null : document.activeElement as HTMLElement | null));
  const [confirming, setConfirming] = useState(false);
  const context: PremiumDialogContextValue = { mode, presentation: kind, stepped, setStepped };
  const guard = (event: Event) => {
    if (!dirty || event.defaultPrevented) return;
    event.preventDefault();
    setConfirming(true);
  };
  const handlers = {
    onEscapeKeyDown: (event: KeyboardEvent) => {
      onEscapeKeyDown?.(event);
      if (confirming && !event.defaultPrevented) { event.preventDefault(); setConfirming(false); return; }
      guard(event);
    },
    onInteractOutside: (event: Parameters<NonNullable<ContentProps["onInteractOutside"]>>[0]) => {
      onInteractOutside?.(event);
      guard(event);
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented || !returnTo?.isConnected || returnTo === document.body) return;
      event.preventDefault();
      returnTo.focus();
    },
  };
  const closeButton = showCloseButton && (
    <DialogPrimitive.Close data-slot="dialog-close"
      className={cn("absolute right-3 z-10 flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none [&_svg]:pointer-events-none [&_svg]:size-4",
        kind === "sheet" ? "top-3" : "top-3 sm:top-4 sm:right-4")}>
      <XIcon />
      <span className="sr-only">Schließen</span>
    </DialogPrimitive.Close>
  );
  const discard = confirming && (
    <DiscardBar mode={mode} onKeep={() => setConfirming(false)} onDiscard={() => { setConfirming(false); requestClose(); }} />
  );
  const body = preview
    ? <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        <aside aria-label="Vorschau" className="hidden w-80 shrink-0 overflow-y-auto border-l border-border/60 bg-surface-sunken/60 p-6 lg:block">{preview}</aside>
      </div>
    : children;

  return (
    <PremiumDialogContext.Provider value={context}>
      <DialogPrimitive.Portal forceMount>
        <DialogPrimitive.Overlay forceMount asChild>
          <MotionBox mode={mode} data-slot="dialog-overlay" data-financial-overlay={financial ? "" : undefined}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-md"
            initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.2 } }} exit={{ opacity: 0, transition: exitTween }} />
        </DialogPrimitive.Overlay>
        {kind === "sheet" ? (
          <DialogPrimitive.Content forceMount asChild {...props} {...handlers}>
            <SheetSurface mode={mode} snapPoints={snapPoints ?? (stepped ? [0.92] : undefined)}
              data-slot="dialog-content" data-variant={variant} data-size={size} className={className}
              onDismiss={() => {
                if (dirty) { setConfirming(true); return false; }
                requestClose();
                return true;
              }}>
              <MotionBox mode={mode} variants={staggerVariants(mode)} initial="hidden" animate="visible" className="flex min-h-0 flex-1 flex-col">
                {body}
              </MotionBox>
              {closeButton}
              {discard}
            </SheetSurface>
          </DialogPrimitive.Content>
        ) : (
          <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4 sm:p-6">
            <DialogPrimitive.Content forceMount asChild {...props} {...handlers}>
              <MotionBox mode={mode} data-slot="dialog-content" data-variant={variant} data-presentation="modal" data-size={size}
                variants={contentVariants(mode)} initial="hidden" animate="visible" exit="exit"
                className={cn(
                  "pointer-events-auto relative flex max-h-[min(88dvh,56rem)] w-full min-h-0 flex-col overflow-hidden rounded-3xl border bg-card text-card-foreground shadow-overlay outline-none",
                  sizes[size], preview && "lg:max-w-5xl", stepped && stepHeights[size], className,
                )}>
                {body}
                {closeButton}
                {discard}
              </MotionBox>
            </DialogPrimitive.Content>
          </div>
        )}
      </DialogPrimitive.Portal>
    </PremiumDialogContext.Provider>
  );
}

function DiscardBar({ mode, onKeep, onDiscard }: { mode: MotionMode; onKeep: () => void; onDiscard: () => void }) {
  return (
    <MotionBox mode={mode} role="group" aria-label="Ungespeicherte Eingaben"
      initial={mode === "full" ? { y: "100%" } : { opacity: 0 }} animate={mode === "full" ? { y: 0 } : { opacity: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      className="absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-3 border-t border-border bg-card px-6 py-4 pb-[calc(1rem+var(--safe-bottom,0px))] shadow-[0_-16px_40px_-20px_rgb(0_0_0/0.45)] sm:px-8">
      <p className="min-w-0 flex-1 text-sm font-medium">Ungespeicherte Eingaben verwerfen?</p>
      <div className="flex w-full gap-2 sm:w-auto">
        <Button type="button" variant="ghost" className="flex-1 sm:flex-none" autoFocus onClick={onKeep}>Weiter bearbeiten</Button>
        <Button type="button" variant="destructive" className="flex-1 sm:flex-none" onClick={onDiscard}>Verwerfen</Button>
      </div>
    </MotionBox>
  );
}

export function PremiumDialogHeader({ title, description, icon: Icon, className, children }: {
  title: ReactNode; description?: ReactNode; icon?: LucideIcon; className?: string; children?: ReactNode;
}) {
  const { mode, presentation } = usePremiumDialog();
  return (
    <MotionBox mode={mode} variants={itemVariants(mode)} data-sheet-drag data-slot="dialog-header"
      className={cn("shrink-0 space-y-1.5 px-6 pr-16 pb-4 text-left sm:px-8 sm:pr-20", presentation === "sheet" ? "touch-none pt-1 select-none" : "pt-6 sm:pt-7", className)}>
      {Icon && <span aria-hidden="true" className="mb-3 flex size-10 items-center justify-center rounded-xl bg-accent-muted text-primary"><Icon className="size-5" /></span>}
      <DialogTitle>{title}</DialogTitle>
      {description && <DialogDescription>{description}</DialogDescription>}
      {children}
    </MotionBox>
  );
}

export function PremiumDialogBody({ className, ...props }: Omit<ComponentProps<"div">, "ref">) {
  const body = useRef<HTMLDivElement>(null);
  const focus = useScrollableFocus(body);
  return <div ref={body} data-slot="dialog-body" tabIndex={focus.tabIndex}
    className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 sm:px-8", focus.className, className)} {...props} />;
}

export function PremiumDialogFooter({ className, children }: { className?: string; children: ReactNode }) {
  const { mode, presentation } = usePremiumDialog();
  return (
    <MotionBox mode={mode} variants={itemVariants(mode)} data-slot="dialog-footer"
      className={cn("flex shrink-0 flex-col items-stretch justify-end gap-2 border-t border-border/60 bg-muted/20 px-6 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:px-8",
        presentation === "sheet" && "pb-[calc(1rem+var(--safe-bottom,0px))]", className)}>
      <DialogFooterButtonContext.Provider value>{children}</DialogFooterButtonContext.Provider>
    </MotionBox>
  );
}

/** Stagger target for custom blocks inside a premium dialog. */
export function PremiumDialogItem({ className, children }: { className?: string; children: ReactNode }) {
  const { mode } = usePremiumDialog();
  return <MotionBox mode={mode} variants={itemVariants(mode)} className={className}>{children}</MotionBox>;
}

export {
  Dialog as PremiumDialog,
  DialogClose as PremiumDialogClose,
  DialogForm as PremiumDialogForm,
  DialogTrigger as PremiumDialogTrigger,
};
