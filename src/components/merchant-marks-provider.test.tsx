// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  AccountWorkspaceContext,
  type AccountWorkspace,
} from "@/components/account-context";
import { MerchantMark } from "@/components/merchant-mark";
import {
  MerchantMarksProvider,
  useMerchantMarks,
} from "@/components/merchant-marks-provider";
import { Transactions } from "@/components/transactions";
import { useFinance } from "@/components/finance-provider";
import { actualBookings, calculateDashboard, classify } from "@/lib/calc";
import { createEmptyAccountState } from "@/lib/account-state";
import type { Transaction } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/statement-import", () => ({
  StatementImport: () => null,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const version = "a".repeat(64);
const booking: Transaction = {
  id: "merchant-mark",
  date: "2026-10-06",
  bank: "Revolut",
  pocket: null,
  description: "Private bank description",
  amount: -42,
  category: "Shopping",
  categoryOverride: true,
  includeInPlan: true,
  merchantAlias: "Möbel Müller",
  merchantId: "muller",
  merchantLogo: false,
};

function account(id = "first"): AccountWorkspace {
  return {
    user: { id, username: "test-user", role: "user" },
    loadServer: vi.fn(),
  };
}

function mark(row = booking) {
  return <MerchantMark booking={row} classification={classify(row)} />;
}

function tree(
  ids = ["muller"],
  workspace: AccountWorkspace | null = account(),
  children: ReactNode = mark(),
  names: string[] = [],
) {
  return (
    <AccountWorkspaceContext.Provider value={workspace}>
      <MerchantMarksProvider merchantIds={ids} merchantNames={names}>
        {children}
      </MerchantMarksProvider>
    </AccountWorkspaceContext.Provider>
  );
}

function logoResponse(assetId = "muller-licensed") {
  return Response.json({
    marks: [{ merchantId: "muller", logo: { merchantId: assetId, version } }],
  });
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("loads historical false flags with one deduplicated request, including under Strict Mode", async () => {
  const fetch = vi.fn().mockImplementation(async () => logoResponse());
  vi.stubGlobal("fetch", fetch);
  const workspace = account();
  const children = (
    <>
      {mark()}
      {mark({ ...booking, id: "second" })}
    </>
  );
  const { container, rerender } = render(
    <StrictMode>{tree(["muller", "muller"], workspace, children)}</StrictMode>,
  );
  expect(container.querySelector("img")).toBeNull();
  await waitFor(() =>
    expect(container.querySelectorAll("img")).toHaveLength(2),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe("/api/merchants/marks");
  expect(JSON.parse(options.body)).toEqual({ merchantIds: ["muller"] });
  expect(options.method).toBe("POST");
  expect(options.credentials).toBe("same-origin");
  expect(options.cache).toBe("no-store");
  expect(options.body).not.toContain(booking.description);
  expect(options.body).not.toContain(booking.merchantAlias);
  expect(container.querySelector("img")!.getAttribute("src")).toBe(
    `/api/merchants/muller-licensed/logo?v=${version}`,
  );
  expect(container.querySelector("a")!.getAttribute("href")).toBe(
    `/api/merchants/muller-licensed/attribution?v=${version}`,
  );
  rerender(<StrictMode>{tree(["muller"], workspace, children)}</StrictMode>);
  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("batches exact named marks for legacy subscriptions without sending descriptions or mutating bookings", async () => {
  const row = {
    ...booking,
    merchantId: undefined,
    merchantAlias: "Audi | Abo",
  };
  const before = structuredClone(row);
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      marks: [],
      nameMarks: [
        { merchantName: "Audi", logo: { merchantId: "audi", version } },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const { container } = render(
    tree([], account(), mark(row), ["Audi", "Audi"]),
  );
  await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    merchantIds: [],
    merchantNames: ["Audi"],
  });
  expect(container.querySelector("img")!.getAttribute("src")).toBe(
    `/api/merchants/audi/logo?v=${version}`,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(row).toEqual(before);
});

it("splits displayed IDs into bounded batches and never requests duplicates or invalid IDs", async () => {
  const fetch = vi.fn().mockImplementation(async (_url, options) => {
    const { merchantIds } = JSON.parse(options.body) as {
      merchantIds: string[];
    };
    return Response.json({
      marks: merchantIds.map((merchantId) => ({ merchantId, logo: null })),
    });
  });
  vi.stubGlobal("fetch", fetch);
  const ids = Array.from({ length: 237 }, (_, index) => `merchant-${index}`);
  const { rerender } = render(
    tree([...ids, ids[0], "invalid/id", " ", " padded ", "x".repeat(101)]),
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  await act(async () => {});
  const batches = fetch.mock.calls.map(
    ([, options]) => JSON.parse(options.body).merchantIds as string[],
  );
  expect(batches.map((batch) => batch.length)).toEqual([100, 100, 37]);
  expect(batches.flat().sort()).toEqual(ids.sort());
  rerender(tree([...ids].reverse()));
  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("bounds the account cache instead of retaining every visited merchant", async () => {
  const fetch = vi.fn().mockImplementation(async (_url, options) =>
    Response.json({
      marks: JSON.parse(options.body).merchantIds.map((merchantId: string) => ({
        merchantId,
        logo: null,
      })),
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const ids = (page: number) =>
    Array.from({ length: 100 }, (_, index) => `merchant-${page}-${index}`);
  const { rerender } = render(tree(ids(0)));
  for (let page = 0; page < 6; page++) {
    if (page) rerender(tree(ids(page)));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(page + 1));
    await act(async () => {});
  }
  rerender(tree(ids(0)));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(7));
});

it("protects a displayed oldest cached logo when a new ID fills an already-full cache", async () => {
  const fetch = vi.fn().mockImplementation(async (_url, options) => {
    const { merchantIds } = JSON.parse(options.body) as {
      merchantIds: string[];
    };
    return Response.json({
      marks: merchantIds.map((merchantId) => ({
        merchantId,
        logo: { merchantId, version },
      })),
    });
  });
  vi.stubGlobal("fetch", fetch);
  const ids = Array.from(
    { length: 500 },
    (_, index) => `merchant-${String(index).padStart(3, "0")}`,
  );
  function CacheSize() {
    return (
      <output aria-label="Merchant metadata count">
        {useMerchantMarks()?.size}
      </output>
    );
  }
  const oldest = { ...booking, merchantId: ids[0] };
  const workspace = account();
  const { container, rerender } = render(
    tree(
      ids,
      workspace,
      <>
        {mark(oldest)}
        <CacheSize />
      </>,
    ),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Merchant metadata count").textContent).toBe(
      "500",
    ),
  );
  expect(fetch).toHaveBeenCalledTimes(5);
  const visibleIds = [ids[0], "merchant-new"];
  const children = (
    <>
      {mark(oldest)}
      {mark({ ...booking, merchantId: "merchant-new" })}
      <CacheSize />
    </>
  );
  rerender(tree(visibleIds, workspace, children));
  await waitFor(() =>
    expect(
      container.querySelector('img[src*="/merchant-new/"]'),
    ).not.toBeNull(),
  );
  expect(container.querySelectorAll("img")).toHaveLength(2);
  expect(container.querySelector(`img[src*="/${ids[0]}/"]`)).not.toBeNull();
  expect(screen.getByLabelText("Merchant metadata count").textContent).toBe(
    "500",
  );
  expect(fetch).toHaveBeenCalledTimes(6);
  expect(JSON.parse(fetch.mock.calls[5][1].body)).toEqual({
    merchantIds: ["merchant-new"],
  });
  rerender(tree([...visibleIds], workspace, children));
  await act(async () => {});
  expect(container.querySelectorAll("img")).toHaveLength(2);
  expect(fetch).toHaveBeenCalledTimes(6);
});

it.each([null, undefined])(
  "uses initials for unavailable or omitted current logos without trusting a stale flag (%s)",
  async (logo) => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        marks: logo === undefined ? [] : [{ merchantId: "muller", logo }],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const { container, rerender } = render(
      tree(["muller"], account(), mark({ ...booking, merchantLogo: true })),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("MM")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      tree(["muller"], account(), mark({ ...booking, merchantLogo: true })),
    );
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it.each([
  {
    marks: [
      { merchantId: "muller", logo: { merchantId: "asset", version: "bad" } },
    ],
  },
  {
    marks: [
      {
        merchantId: "muller",
        logo: { merchantId: "https://remote/logo", version },
      },
    ],
  },
  { marks: [{ merchantId: "unrequested", logo: null }] },
  {
    marks: [
      { merchantId: "muller", logo: null },
      { merchantId: "muller", logo: null },
    ],
  },
  {
    marks: Array.from({ length: 101 }, () => ({
      merchantId: "muller",
      logo: null,
    })),
  },
])(
  "surfaces one contextual status for invalid metadata without retries: %j",
  async (body) => {
    const fetch = vi.fn().mockResolvedValue(Response.json(body));
    vi.stubGlobal("fetch", fetch);
    const { container, rerender } = render(tree(["muller", "muller"]));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toContain("Initialen");
    expect(container.querySelector("img")).toBeNull();
    rerender(tree(["muller"]));
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  },
);

it.each(["network", "http", "oversized", "json"])(
  "falls back and reports a %s response failure without polling",
  async (failure) => {
    const fetch = vi.fn().mockImplementation(async () => {
      if (failure === "network") throw new TypeError("Network unavailable");
      if (failure === "http") return new Response(null, { status: 503 });
      if (failure === "oversized") return new Response(" ".repeat(65_537));
      return new Response("not JSON");
    });
    vi.stubGlobal("fetch", fetch);
    const { container } = render(tree());
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("MM")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("uses only initials without endpoint requests in local mode", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { container } = render(
    tree(["muller"], null, mark({ ...booking, merchantLogo: true })),
  );
  await act(async () => {});
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("MM")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});

it("times out a stalled batch once without automatic retries", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(
    (_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const { container } = render(tree());
  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(screen.getByRole("status")).toBeTruthy();
  expect(container.querySelector("img")).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("aborts and resets metadata immediately on account switches and logout", async () => {
  const next = deferred();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(logoResponse())
    .mockReturnValueOnce(next.promise);
  vi.stubGlobal("fetch", fetch);
  const { container, rerender } = render(tree());
  await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
  const firstSignal = fetch.mock.calls[0][1].signal as AbortSignal;
  rerender(tree(["muller"], account("second")));
  expect(container.querySelector("img")).toBeNull();
  expect(firstSignal.aborted).toBe(true);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const secondSignal = fetch.mock.calls[1][1].signal as AbortSignal;
  rerender(tree(["muller"], null));
  expect(secondSignal.aborted).toBe(true);
  await act(async () => {
    next.resolve(logoResponse("old-account-asset"));
  });
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("MM")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("discards older in-flight responses after the displayed merchant IDs change", async () => {
  const older = deferred();
  const fetch = vi
    .fn()
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce(
      Response.json({
        marks: [{ merchantId: "auer", logo: { merchantId: "auer", version } }],
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const { container, rerender, unmount } = render(tree());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const signal = fetch.mock.calls[0][1].signal as AbortSignal;
  rerender(
    tree(
      ["auer"],
      account(),
      mark({
        ...booking,
        merchantId: "auer",
        merchantAlias: "Martin Auer",
      }),
    ),
  );
  expect(signal.aborted).toBe(true);
  await waitFor(() =>
    expect(container.querySelector("img")!.getAttribute("src")).toBe(
      `/api/merchants/auer/logo?v=${version}`,
    ),
  );
  await act(async () => {
    older.resolve(logoResponse("stale"));
  });
  expect(container.querySelector("img")!.getAttribute("src")).toContain(
    "/auer/",
  );
  expect(screen.queryByRole("status")).toBeNull();
  const currentSignal = fetch.mock.calls[1][1].signal as AbortSignal;
  unmount();
  expect(currentSignal.aborted).toBe(true);
});

it.each([false, true])(
  "shares one current mark batch on table/mobile surfaces and excludes transfers (mobile: %s)",
  async (mobile) => {
    let compact = mobile;
    let layoutChanged: (() => void) | undefined;
    vi.stubGlobal("matchMedia", () => ({
      matches: compact,
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        layoutChanged = listener;
      }),
      removeEventListener: vi.fn(),
    }));
    const fetch = vi.fn().mockImplementation(async () =>
      Response.json({
        marks: [
          {
            merchantId: "muller",
            logo: { merchantId: "muller-licensed", version },
          },
        ],
        nameMarks: [
          { merchantName: "Audi", logo: { merchantId: "audi", version } },
          { merchantName: "Mein Händler", logo: null },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const state = createEmptyAccountState();
    state.settings.asOf = "2026-10-07";
    state.settings.baselineDate = "2026-10-01";
    state.transactions = [
      booking,
      { ...booking, id: "repeat", date: "2026-10-05" },
      {
        ...booking,
        id: "subscription",
        date: "2026-10-05",
        merchantAlias: "Audi | Abo",
        merchantId: undefined,
      },
      {
        ...booking,
        id: "transfer",
        date: "2026-10-04",
        merchantId: "transfer-only",
        merchantAlias: "Eigenes Konto",
        category: "Transfer intern",
      },
      {
        ...booking,
        id: "source-transfer",
        date: "2026-10-03",
        merchantId: "source-transfer-only",
        merchantAlias: "Externes Konto",
        sourceCategory: "SEPA Überweisung",
      },
      {
        ...booking,
        id: "manual",
        date: "2026-10-02",
        merchantAlias: "Mein Händler",
        merchantId: undefined,
        merchantLogo: true,
      },
      {
        ...booking,
        id: "older",
        date: "2026-09-05",
        merchantId: "not-displayed",
      },
    ];
    const update = vi.fn();
    vi.mocked(useFinance).mockReturnValue({
      state,
      dashboard: calculateDashboard(state),
      update,
      replace: vi.fn(),
      openReviewCount: 0,
      ready: true,
      saved: true,
      storageError: null,
      retrySave: vi.fn(),
      appendStatements: vi.fn(),
      statementImport: undefined,
    });
    const ledgerBefore = actualBookings(state);
    render(
      <AccountWorkspaceContext.Provider value={account()}>
        <Transactions />
      </AccountWorkspaceContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Weitere Filter" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Transfers anzeigen" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    const ledger = mobile
      ? screen.getByRole("list", { name: "Mobile Buchungen" })
      : screen.getByRole("table", { name: "Buchungen" });
    await waitFor(() => expect(ledger.querySelectorAll("img")).toHaveLength(3));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      merchantIds: ["muller"],
      merchantNames: ["Audi", "Mein Händler"],
    });
    for (const image of ledger.querySelectorAll("img")) {
      const audi = image.getAttribute("src")?.includes("/audi/");
      const asset = audi ? "audi" : "muller-licensed";
      expect(image.getAttribute("src")).toBe(
        `/api/merchants/${asset}/logo?v=${version}`,
      );
      expect(image.width).toBe(32);
      expect(image.height).toBe(32);
      expect(image.closest("a")!.className).toContain("size-8");
      expect(image.closest("a")!.getAttribute("href")).toBe(
        `/api/merchants/${asset}/attribution?v=${version}`,
      );
      expect(image.closest("a")!.nextElementSibling!.textContent).toBe(
        audi ? "Audi | Abo" : "Möbel Müller",
      );
    }
    expect(screen.getByText("Eigenes Konto").previousElementSibling).toBeNull();
    expect(
      screen.getByText("Externes Konto").previousElementSibling,
    ).toBeNull();
    expect(
      screen.getByText("Mein Händler").previousElementSibling?.textContent,
    ).toBe("MH");
    expect(actualBookings(state)).toEqual(ledgerBefore);
    expect(update).not.toHaveBeenCalled();
    act(() => {
      compact = !mobile;
      layoutChanged?.();
    });
    const switchedLedger = mobile
      ? screen.getByRole("table", { name: "Buchungen" })
      : screen.getByRole("list", { name: "Mobile Buchungen" });
    expect(switchedLedger.querySelectorAll("img")).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("loads only the visible page and reuses the batch when returning to a visited page", async () => {
  const fetch = vi.fn().mockImplementation(async (_url, options) => {
    const { merchantIds } = JSON.parse(options.body) as {
      merchantIds: string[];
    };
    return Response.json({
      marks: merchantIds.map((merchantId) => ({
        merchantId,
        logo: { merchantId, version },
      })),
    });
  });
  vi.stubGlobal("fetch", fetch);
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-01";
  state.transactions = Array.from({ length: 26 }, (_, index) => ({
    ...booking,
    id: `booking-${index}`,
    date: index === 25 ? "2026-10-01" : "2026-10-06",
    merchantId: index === 25 ? "next-page" : "muller",
  }));
  vi.mocked(useFinance).mockReturnValue({
    state,
    dashboard: calculateDashboard(state),
    update: vi.fn(),
    replace: vi.fn(),
    openReviewCount: 0,
    ready: true,
    saved: true,
    storageError: null,
    retrySave: vi.fn(),
    appendStatements: vi.fn(),
    statementImport: undefined,
  });
  const { container } = render(
    <AccountWorkspaceContext.Provider value={account()}>
      <Transactions />
    </AccountWorkspaceContext.Provider>,
  );
  await waitFor(() =>
    expect(container.querySelectorAll("img")).toHaveLength(25),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    merchantIds: ["muller"],
  });
  fireEvent.click(screen.getByRole("button", { name: "Nächste Seite" }));
  await waitFor(() =>
    expect(container.querySelector("img")!.getAttribute("src")).toContain(
      "/next-page/",
    ),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    merchantIds: ["next-page"],
  });
  fireEvent.click(screen.getByRole("button", { name: "Vorherige Seite" }));
  expect(container.querySelectorAll("img")).toHaveLength(25);
  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(2);
});
