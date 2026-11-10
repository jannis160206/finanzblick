// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Link from "next/link";
import { Check } from "lucide-react";
import { Button, buttonVariants } from "./button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogForm, DialogHeader, DialogTitle, DialogTrigger } from "./dialog";

afterEach(cleanup);

describe("shared button", () => {
  it.each(["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const)(
    "keeps pill primaries, fixed icon spacing and press/focus behavior at size %s", (size) => {
      const classes = buttonVariants({ size });
      for (const value of ["rounded-full", "gap-2", "hover:-translate-y-px", "hover:shadow-", "active:scale-[0.98]",
        "focus-visible:ring-1", "[&_svg]:size-4", "[&_svg]:max-h-[1lh]", "[&_svg]:shrink-0",
        "translate,scale", "motion-reduce:translate-none", "motion-reduce:scale-100"])
        expect(classes).toContain(value);
      expect(classes).not.toContain("ring-[3px]");
      expect(classes).not.toContain("gap-1");
    },
  );

  it.each(["outline", "ghost"] as const)("keeps %s rounded-xl outside a footer", (variant) => {
    render(<Button variant={variant}><Check className="size-6" />Action</Button>);
    const button = screen.getByRole("button", { name: "Action" });
    expect(button.getAttribute("data-variant")).toBe(variant);
    expect(button.className).toContain("rounded-xl");
    expect(button.className).not.toContain("rounded-full");
  });

  it("preserves disabled actions and asChild links", () => {
    const click = vi.fn();
    render(<><Button disabled onClick={click}>Disabled</Button><Button asChild><Link href="/umsaetze">Bookings</Link></Button></>);
    fireEvent.click(screen.getByRole("button", { name: "Disabled" }));
    expect(click).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Bookings" }).getAttribute("href")).toBe("/umsaetze");
  });
});

describe("shared dialog", () => {
  it.each(["default", "confirmation", "work"] as const)("opens %s as a centered premium modal with a borderless responsive footer", (variant) => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild><Button>Open</Button></DialogTrigger>
        <DialogContent variant={variant}>
          <DialogHeader><DialogTitle>Details</DialogTitle><DialogDescription>One line description</DialogDescription></DialogHeader>
          <DialogBody>Content</DialogBody>
          <DialogFooter><DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose><Button>Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>;
    }
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(dialog.getAttribute("data-state")).toBe("open");
    // Scale and fade come from the shared motion springs (no animation under test); the surface is a centered modal.
    expect(dialog.getAttribute("data-presentation")).toBe("modal");
    expect(dialog.getAttribute("data-variant")).toBe(variant);
    expect(dialog.getAttribute("data-size")).toBe({ default: "md", confirmation: "sm", work: "xl" }[variant]);
    expect(dialog.className).toContain("rounded-3xl");
    expect(dialog.className).not.toContain("slide-");
    const overlay = view.baseElement.querySelector('[data-slot="dialog-overlay"]')!;
    expect(overlay.className).toContain("bg-black/50");
    expect(overlay.className).toContain("backdrop-blur-md");
    expect(overlay.className).not.toMatch(/zoom|slide/);
    const header = dialog.querySelector('[data-slot="dialog-header"]')!;
    expect(header.className).not.toContain("border-b");
    expect(header.className).toContain("p-6");
    expect(screen.getByRole("heading", { name: "Details" }).className).toContain("text-xl");
    expect(dialog.querySelector('[data-slot="dialog-description"]')!.className).not.toContain("truncate");
    expect(within(dialog).getByRole("button", { name: "Schließen" }).className).toContain("rounded-full");
    const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
    expect(footer.className).not.toContain("border-t");
    expect(footer.className).toContain("backdrop-blur-md");
    expect(footer.className).toContain("flex-col");
    expect(footer.className).toContain("sm:flex-row");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(cancel.getAttribute("data-variant")).toBe("ghost");
    expect(cancel.className).toContain("order-1");
    expect(save.className).toContain("order-2");
    expect(save.className).toContain("w-full sm:w-auto");
    expect(save.className).toContain("rounded-full");
    expect(footer.querySelectorAll('[data-variant="default"]')).toHaveLength(1);
    fireEvent.click(cancel);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("preserves submission, cancellation and destructive action colors", () => {
    const submit = vi.fn();
    const cancel = vi.fn();
    render(<DialogForm onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <DialogFooter><Button variant="outline" type="button" onClick={cancel}>Cancel</Button>
        <Button variant="destructive" type="submit">Delete</Button></DialogFooter>
    </DialogForm>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    const action = screen.getByRole("button", { name: "Delete" });
    expect(action.getAttribute("data-variant")).toBe("destructive");
    expect(action.className).toContain("bg-destructive");
    expect(action.className).toContain("rounded-full");
    fireEvent.click(action);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("keeps navigation drawers directional and the optional footer close button ghost", () => {
    render(<Dialog defaultOpen><DialogContent variant="navigation">
      <DialogHeader><DialogTitle>Navigation</DialogTitle><DialogDescription>Destinations</DialogDescription></DialogHeader>
      <DialogBody>Links</DialogBody><DialogFooter showCloseButton />
    </DialogContent></Dialog>);
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog.className).toContain("slide-in-from-left");
    expect(dialog.className).not.toContain("zoom-in-95");
    const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
    expect(within(footer).getByRole("button", { name: "Schließen" }).getAttribute("data-variant")).toBe("ghost");
  });
});
