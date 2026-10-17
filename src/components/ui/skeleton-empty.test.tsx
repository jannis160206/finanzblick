// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import Link from "next/link";
import { ReceiptText } from "lucide-react";
import { afterEach, expect, it } from "vitest";
import { EmptyState } from "./empty-state";
import { Skeleton } from "./skeleton";

afterEach(cleanup);

it("renders an empty state with title, icon and action while hiding the decorative icon", () => {
  const { container } = render(<EmptyState icon={ReceiptText} title="Noch keine Ausgaben"><Link href="/x">Importieren</Link></EmptyState>);
  expect(screen.getByText("Noch keine Ausgaben")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Importieren" })).toBeTruthy();
  expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});

it("renders an empty state without icon or children", () => {
  const { container } = render(<EmptyState title="Leer" />);
  expect(container.querySelector("svg")).toBeNull();
  expect(container.querySelector("[data-slot=empty-state] > div")).toBeNull();
});

it("hides skeleton placeholders from assistive technology and honors reduced motion", () => {
  const { container } = render(<Skeleton className="h-4" />);
  const node = container.querySelector("[data-slot=skeleton]")!;
  expect(node.getAttribute("aria-hidden")).toBe("true");
  expect(node.className).toContain("motion-safe:animate-pulse");
  expect(node.className).toContain("h-4");
});
