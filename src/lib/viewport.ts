import type { Viewport } from "next";

export const appViewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f7f6" },
    { media: "(prefers-color-scheme: dark)", color: "#101313" },
  ],
};
