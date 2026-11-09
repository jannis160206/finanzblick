# Design-Tokens

Bestandsaufnahme der visuellen Grundlagen von Finanzblick (Stand vor dem UI-Umbau, Branch `main` @ `a966872`) und Zielwerte für den Umbau. Quelle der Wahrheit bleibt `src/app/globals.css`; dieses Dokument beschreibt, was dort definiert ist und wie es verwendet wird.

## 1. Quellen

| Datei | Inhalt |
| --- | --- |
| `src/app/globals.css` | Tailwind-4-Theme (`@theme inline`), CSS-Variablen für Hell/Dunkel, saisonale Themes, Komponentenklassen (`.panel`, `.eyebrow`, `.status-pill`, `.select-input`, `.editable`, `.data-table`, `.month-grid`), Animationen |
| `src/app/security-mode.css` | Sichtschutz: Blur `10px` auf `[data-financial-data]`, Portals/Toasts ausgeblendet |
| `src/lib/appearance.ts` | Benutzer-Akzentfarbe → `--user-accent*` (Kontrast ≥ 5:1 automatisch berechnet) |
| `src/lib/seasonal-theme.ts` | Saisonale Themes setzen `data-theme` auf `<html>` |
| `src/lib/viewport.ts`, `src/app/manifest.ts` | Theme-Farbe der PWA (`#f5f7f6` hell, `#101313` dunkel) |
| `src/app/layout.tsx` | Schriften Geist Sans / Geist Mono (`geist`-Paket, lokal ausgeliefert) |
| `components.json` | shadcn/ui-Konfiguration (Stil `new-york`, Basis `neutral`, CSS-Variablen, Icons `lucide`) |
| `src/components/ui/*` | shadcn-artige Primitive: `button`, `dialog`, `dropdown-menu`, `popover`, `tooltip`, `input`, `label`, `skeleton`, `empty-state` |

## 2. Ist-Zustand

### 2.1 Farben

Semantische Variablen nach shadcn-Konvention, in `@theme inline` als `--color-*` an Tailwind gebunden (`bg-card`, `text-muted-foreground` …).

| Token | Hell | Dunkel | Verwendung |
| --- | --- | --- | --- |
| `--background` | `#f5f7f6` | `#101313` | Seitenhintergrund |
| `--foreground` | `oklch(0.145 0 0)` | `#edf2ef` | Text |
| `--card` | `oklch(1 0 0)` | `#181c1b` | Karten, Panels, Dialoge |
| `--popover` | `oklch(1 0 0)` | `#1d2320` | Popover, Tooltip, Select-Picker |
| `--primary` | `var(--user-accent, #5bddad)` | gleich | Akzent (Buttons, aktive Navigation, positive Beträge) |
| `--primary-foreground` | `var(--user-accent-foreground, #000)` | gleich | Text auf Akzent |
| `--accent-ink` | `var(--user-accent-light, #087c58)` | `var(--user-accent-dark, #5bddad)` | lesbare Akzentfarbe für Text; `.text-primary` wird darauf umgebogen |
| `--secondary` / `--muted` / `--accent` | `oklch(0.97 0 0)` | `#272e2b` / `#252b28` / `#232b27` | Flächen, Hover |
| `--muted-foreground` | `#66736d` | `#94a19a` | Sekundärtext |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | Fehler, negative Beträge |
| `--border` / `--input` | `oklch(0.922 0 0)` | `#2a322e` / `#38423c` | Rahmen |
| `--ring` | `var(--accent-ink)` | gleich | Fokus |
| `--chart-1` … `--chart-7` | Akzent, `#0284c7`, `#b45309`, `#c2410c`, `#737373`, `#dc2626`, `#475569` | hellere Varianten | Diagramme, Pocket-Farben |
| `--accent-muted` | `color-mix(primary 8 %, card)` | – | dezente Akzentfläche |
| `--editable-*` | Gelbtöne (`#fff2c4` …) | Brauntöne | Eingabefelder für Planwerte (`.editable`) |
| `--sidebar*` | `oklch(0.985 0 0)` … | `#141817` … | Sidebar |
| `--season-tint`, `--season-decoration` | je Saison | je Saison | saisonale Tönung von Sidebar, Header, Karten |

Akzentfarben (Einstellungen → Erscheinungsbild): Mint `#5bddad` (Standard), Blau `#60a5fa`, Violett `#a78bfa`, Rose `#fb7185`, Gold `#e5b85c`, Türkis `#2dd4bf` oder frei wählbar. `accentTokens()` berechnet daraus Vorder-, Hover-, Hell- und Dunkel-Varianten mit Kontrast ≥ 5:1.

Saisonale Themes (`data-theme`): `halloween`, `christmas`, `newyear`, `carnival`, `easter`, `summer`, `betweenyears`. Sie überschreiben `--radius`, `--card-shadow`, `--card-inner` und `--chart-2 … --chart-7`, **nie** die Akzentfarbe.

Direkt verwendete Tailwind-Palettenfarben (außerhalb der Tokens, Zählung in `src/components/**/*.tsx` ohne Tests): `amber-*` 66×, `emerald-*` 28×, `rose-*` 19×, `red-*` 18×, `sky-*` 8×, `violet-*` 5×. Sie stehen für Warnungen (amber), Erfolg (emerald) und Aufteilungsbalken (sky, violet, rose).

### 2.2 Typografie

- Schrift: **Geist Sans** (`--font-sans`) und **Geist Mono** (`--font-mono`), `font-feature-settings: "cv11", "ss01"`, `antialiased`.
- Zahlen: `tabular-nums` an Beträgen, `.data-table` und `.month-grid` setzen `font-variant-numeric: tabular-nums`.
- Zusätzliche Stufe `--text-2xs: 0.6875rem / 1rem` (11 px).
- Häufigkeit der Größen: `text-xs` 296×, `text-sm` 264×, `text-2xs` 59×, `text-xl` 11×, `text-base` 9×, `text-2xl` 8×, `text-3xl`/`4xl`/`5xl` je 3–4×, Pixelwerte `text-[9px]`, `[10px]`, `[11px]`, `[16px]`, `[34px]` (9×).
- Überschriften: Seitentitel `text-3xl sm:text-[34px] font-semibold tracking-tight` (`PageHeading`), Abschnitt `font-semibold tracking-tight` (`SectionHeading`), Dialogtitel `text-xl`.
- `.eyebrow`: `text-2xs font-semibold tracking-[0.14em] text-muted-foreground` (Großbuchstaben-Kicker über Seitentiteln).

### 2.3 Abstände und Layout

- Tailwind-Standardraster (0,25 rem). Häufige Muster: Karten `p-5 sm:p-6`, Grids `gap-3`/`gap-4`/`gap-5`, Seitenabschnitte `mb-5`/`mt-5`.
- Shell: Sidebar `224px` (`lg:pl-[224px]`), Header `76px`, Hauptbereich `max-w-[1600px] px-4 py-6 sm:px-7 sm:py-8 xl:px-9`.
- Breakpoints: Tailwind-Standard (`sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536). Sidebar ab `lg`; darunter Hamburger-Menü als linker Drawer. `useCompactLayout()` und die mobile Umsatzliste schalten bei `max-width: 767px` um.
- Touch: bei `pointer: coarse` erhalten Buttons, Inputs, Menüeinträge, Tabs und Optionen mindestens 44 px Höhe.

### 2.4 Radien

`--radius: 0.625rem` (10 px), daraus `--radius-sm` 6 px, `-md` 8 px, `-lg` 10 px, `-xl` 14 px, `-2xl` 18 px, `-3xl` 22 px, `-4xl` 26 px (saisonal abweichend 6–16 px Basis). Verwendet: `rounded-xl` 72×, `rounded-2xl` 61×, `rounded-full` 52× (Pills, Primärbutton, Badges), `rounded-lg` 34×, `rounded-3xl` 3× (Überschuss-Karte).

### 2.5 Schatten und Tiefe

- `.panel`: `rounded-xl border bg-card shadow-sm`.
- `--card-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)`; saisonal mit Tönung und `--card-inner` (Innenkante, Lichteinfall).
- Dialog: `shadow-[0_20px_60px_-16px_rgb(0_0_0/0.2)]`, Overlay `bg-black/50 backdrop-blur-md`.
- Button-Hover: `-translate-y-px` und `shadow-[0_4px_12px_-4px_rgb(0_0_0/0.15)]`.
- Select-Picker: `0 12px 40px -12px rgb(0 0 0 / 0.3)`.

### 2.6 Bewegung

- Dialoge 200 ms Fade/Zoom (`tw-animate-css`), Drawer Slide.
- Seitenwechsel per View Transition (`.page-fade`, 140 ms aus / 200 ms ein, nicht auf `/umsaetze`).
- Assistent: `assistant-reveal` 320 ms `cubic-bezier(0.22, 1, 0.36, 1)`, Shimmer, Tipp-Punkte.
- Reduzierte Bewegung doppelt abgesichert: `prefers-reduced-motion` **und** `:root[data-reduce-motion="true"]` (App-Einstellung).

### 2.7 Komponenten-Inventar (UI-Basis)

| Komponente | Datei | Hinweise |
| --- | --- | --- |
| `Button` | `ui/button.tsx` | CVA-Varianten `default` (Pill), `destructive`, `outline`, `secondary`, `ghost`, `link`; Größen `xs`–`lg`, `icon*`; im Dialog-Footer automatisch volle Breite mobil |
| `Dialog` | `ui/dialog.tsx` | Varianten `default`, `confirmation`, `work`, `navigation` (Drawer links), `panel` (Drawer rechts); respektiert Sicherheitsmodus |
| `DropdownMenu`, `Popover`, `Tooltip` | `ui/*` | Radix über `radix-ui` |
| `Input`, `Label` | `ui/*` | Fokusring 3 px `ring/20` |
| `Skeleton`, `EmptyState` | `ui/*` | Pulse nur bei `motion-safe` |
| `PageHeading`, `SectionHeading`, `EmptyState`, `MoneyInput` | `finance-ui.tsx` | fachliche Bausteine |
| `.panel`, `.status-pill`, `.select-input`, `.data-table`, `.month-grid`, `.editable` | `globals.css` | Komponentenklassen |
| `FinancialData` | `financial-data.tsx` | markiert sensible Bereiche für den Sichtschutz |
| `MerchantMark` | `merchant-mark.tsx` | Händlerlogo oder Initialen-Fallback |
| `StackedBar`, `CategoryDonut`, Recharts-Flächen | diverse | Charts mit `var(--chart-*)` |

### 2.8 Beobachtete Inkonsistenzen

1. Es fehlt eine `Card`-Primitive; Karten entstehen aus `.panel`, `rounded-2xl border bg-card`, `rounded-3xl` usw. mit unterschiedlichen Radien und Paddings.
2. Statusfarben (Erfolg, Warnung, Info) sind nicht als Tokens definiert; `amber-*`, `emerald-*`, `sky-*` werden direkt verwendet und sind im Dunkelmodus nicht immer abgestimmt.
3. Einnahmen erscheinen in Akzentfarbe, Ausgaben in `chart-4` (Orange) oder Standardfarbe – keine einheitliche Geldfarben-Semantik.
4. Typografie mischt Pixelwerte (`text-[34px]`, `[9px]`) mit der Skala; es gibt keine Stufe für große Kennzahlen.
5. Recharts-Tooltips werden pro Datei als Inline-Objekt gestylt (`chartTooltip`, `tooltipStyle`).
6. Neutrale Grautöne in `oklch(… 0 0)` (achromatisch) stehen neben grünlich getönten Hex-Werten.

## 3. Umgesetzt im Umbau (M1)

Grundsätze: bestehende Token-Namen bleiben erhalten (shadcn-Konvention; `globals.test.ts` prüft `:root`, `.dark`, `body`, `.panel`), Benutzer-Akzentfarbe und saisonale Themes funktionieren unverändert, neue Tokens ergänzen statt ersetzen.

### 3.1 Farben

| Token | Hell | Dunkel | Tailwind-Klasse | Verwendung |
| --- | --- | --- | --- | --- |
| `--foreground` | `oklch(0.2 0.012 165)` | `#edf2ef` | `text-foreground` | Text, leicht grün getönt wie die Flächen |
| `--card` / `--popover` | `#ffffff` | `#171c1a` / `#1c2220` | `bg-card`, `bg-popover` | Karten / schwebende Flächen |
| `--muted`, `--secondary` | `oklch(0.955 0.005 165)` | `#222927`, `#252c29` | `bg-muted` | Flächen, Segment-Hintergrund |
| `--accent` | `oklch(0.948 0.008 165)` | `#232b27` | `bg-accent` | Hover |
| `--surface-sunken` | `oklch(0.968 0.004 165)` | `#131716` | `bg-surface-sunken` | Tabellenkopf, eingelassene Bereiche |
| `--muted-foreground` | `#5d6b64` (≈ 5 : 1 auf Hintergrund) | `#9aa8a1` | `text-muted-foreground` | Sekundärtext |
| `--border` / `--input` | `oklch(0.912 0.006 165)` / `oklch(0.88 0.008 165)` | `#29312e` / `#36403c` | `border-border` | Rahmen |
| `--success` (+ `-foreground`, `-soft`) | `#0a7f58` | `#3fd49b` | `text-success`, `bg-success-soft` | Erfolg, im Rahmen |
| `--warning` (+ `-foreground`, `-soft`) | `#a35207` | `#f5b544` | `text-warning`, `bg-warning-soft` | Hinweis, knapp |
| `--info` (+ `-foreground`, `-soft`) | `#0369a1` | `#4cc2f5` | `text-info`, `bg-info-soft` | Information |
| `--destructive-soft` | 9 % Destructive auf Karte | 9 % | `bg-destructive-soft` | Fehlerflächen |
| `--money-in` | `= --success` | `= --success` | `text-money-in` | Einnahmen, positive Salden |
| `--money-out` | `= --foreground` | `= --foreground` | `text-money-out` | Ausgaben (neutral) |

Unverändert: `--primary`/`--accent-ink` (Benutzer-Akzent), `--chart-1 … 7`, `--editable-*`, saisonale Overrides, `--background` (`#f5f7f6` / `#101313`, passend zu `accentTokens()` und PWA-Theme-Farbe).

### 3.2 Typografie

- Geist Sans/Mono bleiben (lokal ausgeliefert, kein externer Request).
- Neue Stufen: `text-title` (1.75 rem / 2.125 rem, −0.02 em) für Seitentitel ab `sm` (mobil `text-2xl`), `text-display` (2.25 rem / 2.5 rem, −0.03 em) für die zentrale Kennzahl; `text-2xs` bleibt.
- Utility `amount`: `tabular-nums`, `font-weight: 600`, `letter-spacing: -0.02em` für Beträge.
- Seitentitel ohne Kicker/Eyebrow: `PageHeading` rendert nur Titel, optionale Beschreibung und Aktionen.

### 3.3 Radien

- `--radius: 0.75rem` (12 px) → `rounded-lg` 12 px, `rounded-xl` ≈ 17 px (Buttons, Inputs), `rounded-2xl` ≈ 22 px (Karten, Dialoge, `.panel`), `rounded-full` für Pills und Chips. Saisonale Themes setzen weiterhin eigene Basiswerte.

### 3.4 Schatten

| Klasse | Quelle | Hell | Dunkel |
| --- | --- | --- | --- |
| `shadow-card` | `--elevation-card` | 1 px Kontur + weicher 16 px-Schatten | Innenkante + tiefer, weicher Schatten |
| `shadow-raised` | `--elevation-raised` | Hover von Karten und Buttons, Tooltips | stärker |
| `shadow-overlay` | `--elevation-overlay` | Dialoge, Popover, Menüs, Toasts, Chart-Tooltips | stärker |

`.panel` und `Card` nutzen `shadow-card`; das saisonale `--card-inner`/`--card-shadow` überschreibt beide weiterhin.

### 3.5 Layout-Tokens

`--shell-sidebar: 15.5rem`, `--shell-rail: 4.75rem`, `--shell-header: 4rem`, `--shell-bottom-bar: 4rem`, `--safe-bottom: env(safe-area-inset-bottom)` – verwendet ab M2 von der App-Shell.

### 3.6 Bewegung

- Easing-Klassen `ease-soft` (`cubic-bezier(0.22, 1, 0.36, 1)`) und `ease-snappy` (`cubic-bezier(0.32, 0.72, 0, 1)`); Dauern `--duration-fast` 150 ms, `--duration-base` 220 ms, `--duration-slow` 420 ms.
- Bewegung transportiert Zustand (Fortschritt, Auswahl, Wertänderung), keine orchestrierten Seiteneinblendungen. `prefers-reduced-motion` und `data-reduce-motion` schalten alles ab.

### 3.7 Neue Primitive

| Komponente | Datei | Zweck |
| --- | --- | --- |
| `Card` (+ `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter`) | `ui/card.tsx` | Einheitlicher Kartencontainer, optional `interactive` (Hover-Anhebung), `as="section"` |
| `Badge` | `ui/badge.tsx` | Status-Chips `default`, `secondary`, `outline`, `success`, `warning`, `info`, `destructive` |
| `Progress` | `ui/progress.tsx` | Zugänglicher Fortschrittsbalken (`role="progressbar"`, Töne wie Badge) |
| `Separator` | `ui/separator.tsx` | Trennlinie |
| `Kbd` | `ui/kbd.tsx` | Tastenkürzel |
| `SegmentedControl` | `ui/segmented-control.tsx` | Umschalter mit `role="group"` + `aria-pressed` (gleiches Muster wie bestehende Umschalter) |
| `Stat` | `ui/stat.tsx` | Kennzahl mit Label, Betrag (im Sichtschutz) und Hinweis |
| `ChartTooltip`, `chartAxisProps`, `chartGridProps`, `chartCursor`, `chartColors` | `charts/chart-theme.tsx` | Gemeinsames Recharts-Theme statt Inline-Stilobjekten |
| `ThemeProvider` | `theme-provider.tsx` | Hell/Dunkel/System app-weit inkl. Login und Registrierung |
| `useDocumentTheme` | `ui/use-document-theme.ts` | Aktuelles Farbschema für Toasts ohne `next-themes`-Kontext |

Button: neue Variante `soft` (Akzentfläche), Hover-Schatten `shadow-raised`, Outline auf `bg-card`. Dialog, Popover, Dropdown und Tooltip nutzen die Schatten-Tokens. Toasts (`sonner`) folgen dem Farbschema und liegen über der Safe-Area.