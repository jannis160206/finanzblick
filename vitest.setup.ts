import { vi } from "vitest";

// Components render outside an App Router context in unit tests; hooks that need the router get inert stand-ins.
// Tests that need real navigation behaviour declare their own vi.mock("next/navigation").
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/umsaetze",
  useSearchParams: () => new URLSearchParams(typeof location === "undefined" ? "" : location.search),
}));
