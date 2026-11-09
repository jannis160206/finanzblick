import type { MetadataRoute } from "next";

// Nur Installierbarkeit und Darstellung: bewusst kein Service Worker und kein Offline-Cache für Finanzdaten.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Finanzblick · Persönliche Finanzen",
    short_name: "Finanzblick",
    description: "Umsätze, Monatsplanung und Sparziele in deinem privaten Finanzdashboard.",
    lang: "de",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#101313",
    theme_color: "#101313",
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon1.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon2.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon3.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Umsätze", short_name: "Umsätze", url: "/umsaetze", icons: [{ src: "/icon1.png", sizes: "192x192", type: "image/png" }] },
      { name: "Budget", short_name: "Budget", url: "/budget", icons: [{ src: "/icon1.png", sizes: "192x192", type: "image/png" }] },
      { name: "Sparen", short_name: "Sparen", url: "/sparen", icons: [{ src: "/icon1.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}
