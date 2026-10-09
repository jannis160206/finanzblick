// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MerchantMark } from "@/components/merchant-mark";
import * as merchantMarks from "@/components/merchant-marks-provider";
import { classify } from "@/lib/calc";
import { transactionSchema, type Transaction } from "@/lib/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const booking: Transaction = {
  id: "merchant-mark",
  date: "2026-10-06",
  bank: "Revolut",
  pocket: null,
  description: "POS 42,00 AT D1 06.10. 14:30 T9988",
  amount: -42,
  category: "Shopping",
  categoryOverride: true,
  includeInPlan: true,
};

function mark(row = booking) {
  return <MerchantMark booking={row} classification={classify(row)} />;
}

it("uses a 32px canonical alias mark even for a manual alias without a merchant ID", () => {
  const { container } = render(
    mark({ ...booking, merchantAlias: "Möbel Müller" }),
  );
  const badge = screen.getByText("MM");
  expect(badge.className).toContain("size-8");
  expect(badge.className).toContain("shrink-0");
  expect(badge.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelector("img")).toBeNull();
});

it.each(["B1LLA", "BILLA", booking.description])(
  "uses an honest neutral fallback rather than guessing a merchant from %s",
  (description) => {
    const { container } = render(mark({ ...booking, description }));
    expect(screen.getByText("?")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  },
);

it("requests only a licensed same-origin image and exposes its attribution link", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { container } = render(
    mark({
      ...booking,
      merchantAlias: "Möbel Müller",
      merchantId: "müller/at & de",
      merchantLogo: true,
    }),
  );
  const image = container.querySelector("img")!;
  expect(image.getAttribute("src")).toBe(
    "/api/merchants/m%C3%BCller%2Fat%20%26%20de/logo",
  );
  expect(image.width).toBe(32);
  expect(image.height).toBe(32);
  expect(image.getAttribute("loading")).toBe("lazy");
  expect(image.getAttribute("decoding")).toBe("async");
  expect(image.alt).toBe("");
  expect(image.className).toContain("size-8");
  expect(
    screen
      .getByRole("link", {
        name: "Logo-Lizenz und Quellenangabe: Möbel Müller",
      })
      .getAttribute("href"),
  ).toBe("/api/merchants/m%C3%BCller%2Fat%20%26%20de/attribution");
  const attribution = screen.getByRole("link", {
    name: "Logo-Lizenz und Quellenangabe: Möbel Müller",
  });
  expect(attribution.getAttribute("target")).toBe("_blank");
  expect(attribution.getAttribute("rel")).toBe("noopener noreferrer");
  expect(attribution.getAttribute("title")).toBe(
    "Lizenz/Herkunft: Möbel Müller",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { merchantId: "muller" },
  { merchantId: "muller", merchantLogo: false },
  { merchantLogo: true },
  { merchantId: "", merchantLogo: true },
])("does not load a logo without both opt-in and an ID: %j", (metadata) => {
  const { container } = render(
    mark({ ...booking, merchantAlias: "Möbel Müller", ...metadata }),
  );
  expect(screen.getByText("MM")).toBeTruthy();
  expect(container.querySelector("img")).toBeNull();
});

it("recovers from a missing image and tries a new merchant ID without retaining the old failure", () => {
  const original = {
    ...booking,
    merchantAlias: "Möbel Müller",
    merchantId: "muller",
    merchantLogo: true,
  };
  const { container, rerender } = render(mark(original));
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText("MM")).toBeTruthy();
  rerender(
    mark({ ...original, merchantId: "auer", merchantAlias: "Martin Auer" }),
  );
  expect(container.querySelector("img")!.getAttribute("src")).toBe(
    "/api/merchants/auer/logo",
  );
  expect(screen.queryByText("MM")).toBeNull();
  fireEvent.error(container.querySelector("img")!);
  expect(screen.getByText("MA")).toBeTruthy();
});

it("uses current licensed metadata even when the historical logo flag is false", () => {
  const version = "a".repeat(64);
  vi.spyOn(merchantMarks, "useMerchantMarks").mockReturnValue(
    new Map([["muller", { merchantId: "muller-licensed", version }]]),
  );
  const { container } = render(
    mark({
      ...booking,
      merchantAlias: "Möbel Müller",
      merchantId: "muller",
      merchantLogo: false,
    }),
  );
  expect(container.querySelector("img")!.getAttribute("src")).toBe(
    `/api/merchants/muller-licensed/logo?v=${version}`,
  );
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    `/api/merchants/muller-licensed/attribution?v=${version}`,
  );
});

it.each([new Map(), new Map([["muller", null]])])(
  "does not trust a stale true flag when current metadata has no licensed logo",
  (metadata) => {
    vi.spyOn(merchantMarks, "useMerchantMarks").mockReturnValue(metadata);
    const { container } = render(
      mark({
        ...booking,
        merchantAlias: "Möbel Müller",
        merchantId: "muller",
        merchantLogo: true,
      }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("MM")).toBeTruthy();
  },
);

it("clears image failure when a new version of the same licensed asset is available", () => {
  const version = "a".repeat(64);
  const metadata = vi
    .spyOn(merchantMarks, "useMerchantMarks")
    .mockReturnValue(new Map([["muller", { merchantId: "muller", version }]]));
  const row = {
    ...booking,
    merchantAlias: "Möbel Müller",
    merchantId: "muller",
    merchantLogo: false,
  };
  const { container, rerender } = render(mark(row));
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    `/api/merchants/muller/attribution?v=${version}`,
  );
  fireEvent.error(container.querySelector("img")!);
  expect(screen.getByText("MM")).toBeTruthy();
  rerender(mark(row));
  expect(container.querySelector("img")).toBeNull();
  const nextVersion = "b".repeat(64);
  metadata.mockReturnValue(
    new Map([["muller", { merchantId: "muller", version: nextVersion }]]),
  );
  rerender(mark(row));
  expect(container.querySelector("img")!.getAttribute("src")).toBe(
    `/api/merchants/muller/logo?v=${nextVersion}`,
  );
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    `/api/merchants/muller/attribution?v=${nextVersion}`,
  );
  expect(screen.queryByText("MM")).toBeNull();
});

it("does not reattach a logo to a manually corrected name with no merchant ID", () => {
  vi.spyOn(merchantMarks, "useMerchantMarks").mockReturnValue(
    new Map([["muller", { merchantId: "muller", version: "a".repeat(64) }]]),
  );
  const { container } = render(
    mark({ ...booking, merchantAlias: "Mein Händler", merchantLogo: true }),
  );
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("MH")).toBeTruthy();
});

it("uses a neutral fallback for a missing logo with no canonical alias", () => {
  const { container } = render(
    mark({ ...booking, merchantId: "unknown", merchantLogo: true }),
  );
  fireEvent.error(container.querySelector("img")!);
  expect(screen.getByText("?")).toBeTruthy();
});

it("keeps a merchant mark for a positive refund", () => {
  render(
    mark({
      ...booking,
      amount: 42,
      category: "Rückerstattungen",
      merchantAlias: "Möbel Müller",
    }),
  );
  expect(screen.getByText("MM")).toBeTruthy();
});

it("hides unrelated income rather than inventing an employer mark", () => {
  const { container } = render(
    mark({
      ...booking,
      amount: 4200,
      category: "Gehalt",
      description: "Lohnzahlung",
    }),
  );
  expect(container.childElementCount).toBe(0);
});

it.each([
  "Transfer",
  "Transfer intern",
  "Kontoüberweisung",
  "Interne Umbuchung",
])(
  "hides marks for %s even when stale merchant metadata is present",
  (category) => {
    const row = {
      ...booking,
      category: category as Transaction["category"],
      merchantAlias: "Möbel Müller",
      merchantId: "muller",
      merchantLogo: true,
    };
    const { container } = render(mark(row));
    expect(container.childElementCount).toBe(0);
  },
);

it("trusts the shared classification when it detects a transfer independently of its stored category", () => {
  const { container } = render(
    <MerchantMark
      booking={{
        ...booking,
        merchantAlias: "Möbel Müller",
        merchantId: "muller",
        merchantLogo: true,
      }}
      classification={{ category: "Transfer intern", isTransfer: true }}
    />,
  );
  expect(container.childElementCount).toBe(0);
});

it.each([
  { sourceCategory: "SEPA Überweisung" },
  { sourceCategory: "Kontoüberweisung" },
  { rawDescription: "SEPA Überweisung an ein externes Konto" },
])(
  "uses shared transfer suppression for bank source metadata: %j",
  (metadata) => {
    const row = {
      ...booking,
      ...metadata,
      merchantAlias: "Möbel Müller",
      merchantId: "muller",
      merchantLogo: true,
    };
    expect(classify(row).isTransfer).toBe(false);
    const { container } = render(mark(row));
    expect(container.childElementCount).toBe(0);
  },
);

it.each([
  { sourceCategory: "SEPA Lastschrift" },
  { sourceCategory: "Lastschrift" },
  { sourceCategory: "Rückerstattung", amount: 42 },
])("does not hide merchants for direct debits or refunds: %j", (metadata) => {
  render(mark({ ...booking, ...metadata, merchantAlias: "Möbel Müller" }));
  expect(screen.getByText("MM")).toBeTruthy();
});

it.each([undefined, false, true])(
  "retains optional logo availability in the transaction schema (%s)",
  (merchantLogo) => {
    expect(
      transactionSchema.parse({ ...booking, merchantLogo }).merchantLogo,
    ).toBe(merchantLogo);
  },
);

it.each([undefined, "alias", "rule"] as const)(
  "retains optional merchant match provenance in the transaction schema (%s)",
  (merchantMatch) => {
    expect(
      transactionSchema.parse({ ...booking, merchantMatch }).merchantMatch,
    ).toBe(merchantMatch);
  },
);

it("rejects unsupported merchant match provenance", () => {
  expect(
    transactionSchema.safeParse({ ...booking, merchantMatch: "fuzzy" }).success,
  ).toBe(false);
});
