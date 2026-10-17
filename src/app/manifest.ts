import type { MetadataRoute } from "next";

// Nur Installierbarkeit und Darstellung: bewusst kein Service Worker und kein Offline-Cache für Finanzdaten.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Finanzblick · Persönliche Finanzen",
    short_name: "Finanzblick",
    description: "Umsätze, Monatsplanung und Sparziele in deinem privaten Finanzdashboard.",
    lang: "de",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#101313",
    theme_color: "#101313",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
