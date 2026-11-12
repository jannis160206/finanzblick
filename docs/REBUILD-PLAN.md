# UI/UX-Umbau – Plan

Ziel: Finanzblick optisch und strukturell auf das Niveau moderner Finanz-Apps wie Finanzguru bringen – mit eigener Gestaltung, besserer Desktop-Nutzung und ohne Funktionsverlust. Grundlage: `docs/DESIGN-TOKENS.md` (Bestandsaufnahme) und `docs/FINANZGURU-REFERENCE.md` (konzeptionelle Referenz).

## 1. Leitplanken

**Nicht angefasst (harte Grenze)**

- `src/lib/ai/**` – nur Imports/Aufrufe dürfen sich ändern, keine Logik.
- `src/lib/import/**` – Importlogik bleibt; nur die umgebende UI wird neu.
- SQLite-Schema und Migrationen (`src/lib/server/**` Datenbankteil), Auth-Logik (`src/lib/server/auth*`, `src/app/api/auth/**`).
- `.env*`, Secrets, `deploy/` inklusive systemd-Unit.
- Alle API-Routen unter `src/app/api/**` bleiben unverändert.

**Out of Scope:** neue Backend-Features, Auth-Änderungen, native Apps.

**Bestehende Produktregeln, die der Umbau einhält** (aus README/Docs):

- Sicherheitsmodus: sensible Bereiche bleiben in `FinancialData`; neue Portals (Suche, Sheets, Popover) werden im gesperrten Zustand ausgeblendet; Navigation bleibt nutzbar.
- Benutzer-Akzentfarbe und saisonale Themes funktionieren weiter; Themes überschreiben nie den Akzent.
- Reduzierte Bewegung: `prefers-reduced-motion` **und** App-Einstellung `data-reduce-motion`.
- Barrierefreiheit: Tastaturbedienung, sichtbarer Fokus, 44-px-Touchziele, Charts mit Wertetabelle, axe WCAG 2.2 AA ohne kritische/schwere Treffer.
- Suchtexte gehören nicht in die URL (`src/lib/ledger-link.ts`).
- Entfernte Umsatz-Status-Tabs werden nicht wieder eingeführt; alle Sparziele bleiben auffindbar.
- Dialoge: Kopf und Aktionen bleiben sichtbar, Hauptaktion als Pill rechts, mobil volle Breite.

**Code-Stil:** TypeScript strict ohne `any`, Server Components als Standard und `"use client"` nur für interaktive Inseln, Tailwind-Klassen statt Inline-Styles (Ausnahme: berechnete Breiten/Farben von Daten), bestehende Namenskonventionen, keine erklärenden Kommentare für offensichtlichen Code.

## 2. Ausgangslage

- Next.js 16.3.8, React 19.2, Tailwind 4, shadcn/ui (`components.json`, Stil `new-york`) ist bereits teilweise eingeführt (Button, Dialog, DropdownMenu, Popover, Tooltip, Input, Label, Skeleton). TanStack Table, Recharts, Radix (`radix-ui`), `next-themes`, `sonner`, `lucide-react` sind vorhanden.
- Routen: `/` (Übersicht), `/umsaetze`, `/budget`, `/sparen`, `/gehalt-steuern`, `/einstellungen`, `/login`, `/register`; Weiterleitungen `/monate`, `/plan`, `/pockets`, `/assistent`.
- Basislinie vor dem Umbau (Branch `main` @ `a966872`): `npm run typecheck` ✓, `npm test` ✓ (261 Dateien, 4 705 Tests), `npm run build` ✓.
- Zwei Unit-Tests rendern die Shell (`profile-navigation.test.tsx`, `payroll-navigation.test.tsx`) und prüfen Rollen/Namen (`Hauptnavigation`, `Navigation öffnen`, `Benutzerprofil`, Einstellungen zuletzt). Diese Verträge bleiben erhalten.

## 3. Branch- und PR-Strategie

Gestapelte Branches, je Meilenstein ein Commit (M1 zusätzlich mit einem vorangestellten Doku-Commit für Recherche und Plan):

```
main
 └─ rebuild/m1-design-system     PR 1 → main
     └─ rebuild/m2-app-shell     PR 2 → rebuild/m1-design-system
         └─ rebuild/m3-dashboard PR 3 → rebuild/m2-app-shell
             └─ rebuild/m4-transactions
                 └─ rebuild/m5-pages
                     └─ rebuild/m6-polish
```

Nach jedem Meilenstein: `npm run typecheck && npm test && npm run build` (zusätzlich `npm run lint`, weil CI es ausführt). Schlägt etwas fehl, wird es vor dem nächsten Meilenstein behoben. Testanpassungen nur, wenn sich beabsichtigtes Verhalten ändert – jeweils in der Commit-Message begründet.

**Hinweis Remote-Zugriff:** Von dieser Arbeitsumgebung aus ist `github.com/jannis160206/finanzblick` derzeit nicht erreichbar (`gh` ist mit einem anderen Konto angemeldet, `git ls-remote` meldet „Repository not found“). Die Branches werden lokal vollständig vorbereitet; Push und PR-Erstellung erfolgen, sobald Zugriff besteht (Befehle stehen dann in `docs/REBUILD-SUMMARY.md`).

## 4. Meilensteine

### M1 – Design-System

**Ziel:** Ein konsistentes, modernes Token-Fundament und eine shadcn-basierte Komponentenbasis, auf der alle weiteren Meilensteine aufbauen. Dark Mode als gleichwertiger Modus.

Umfang:

1. `globals.css` modernisieren (Namen bleiben kompatibel):
   - einheitlich getönte Neutral-Skala für Hell/Dunkel, Flächenstufen inkl. `--surface-sunken`;
   - Status-Tokens `--success`, `--warning`, `--info` (+ `-foreground`, `-soft`) und `--destructive-soft`;
   - Geldfarben `--money-in`, `--money-out` mit Utilities `text-money-in`/`text-money-out`;
   - Schatten-Tokens `--shadow-card`, `--shadow-raised`, `--shadow-overlay`; `--radius` 0.75 rem;
   - Typo-Stufen `--text-display`, `--text-title`; Utility `.amount` für Kennzahlen;
   - Bewegungs-Tokens (`--ease-out-soft`, Dauern) und Layout-Tokens (`--shell-*`).
   - Saisonale Themes, `.editable`, `.data-table`, `.month-grid`, Sicherheitsmodus-CSS bleiben funktionsgleich.
2. Neue UI-Primitive in `src/components/ui/` (shadcn-Muster, auf vorhandenem `radix-ui` + CVA, keine neuen Pakete): `card`, `badge`, `progress`, `separator`, `kbd`, `segmented-control` (für Monat/Jahr- und ähnliche Umschalter), `stat` (Kennzahl mit Label/Trend).
3. Bestehende Primitive angleichen: `button` (Radius, Fokus, Varianten `soft`), `input`, `dialog` (Radien/Schatten aus Tokens, neues Sheet-Verhalten unten für mobile Panels), `dropdown-menu`, `popover`, `tooltip`, `skeleton`, `empty-state`.
4. Chart-Theme: gemeinsame Recharts-Bausteine (`src/components/charts/chart-theme.ts[x]`: Tooltip, Achsen, Raster, Farbreihe) statt der Inline-Objekte pro Datei.
5. Dark Mode: `next-themes` bleibt; Umschalter bietet Hell/Dunkel/System; Login/Registrierung erhalten Theme-Unterstützung (Auth-Logik unverändert); PWA-Theme-Farben an neue Hintergründe angepasst.
6. `docs/DESIGN-TOKENS.md` auf den umgesetzten Stand bringen.

Abnahme: Alle bestehenden Seiten sehen mit neuen Tokens konsistent aus (keine Layoutbrüche), Hell/Dunkel und alle Akzentfarben/Saisons funktionieren, Checks grün.

### M2 – App-Shell

**Ziel:** Neue Navigation und Kopfzeile, globale Suche, saubere Breakpoints.

Umfang:

1. `app-shell.tsx` aufteilen in `src/components/shell/`: `navigation.ts` (eine Quelle für alle Ziele), `sidebar.tsx`, `bottom-nav.tsx`, `app-header.tsx`, `global-search.tsx`.
2. Breakpoints:
   - `< md` (Handy, 375 px): **Bottom-Bar** mit Übersicht · Umsätze · Budget · Sparen · Mehr (öffnet den bestehenden Navigations-Drawer mit Gehalt & Steuern, Einstellungen, Profil); Safe-Area-Abstand für die installierte PWA; Inhalt bekommt unteren Innenabstand; Assistent-Button sitzt über der Leiste.
   - `md`–`lg` (Tablet, 768 px): **Icon-Rail** (76 px) mit Tooltips, Beschriftung für Screenreader erhalten.
   - `≥ lg` (Desktop, 1440 px): **Sidebar** 248 px mit Logo, Navigation, Prüf-Zähler, Profil bzw. „Privater Workspace“ unten.
3. Header (64 px, sticky, transluzent): Seitentitel, Suchfeld-Trigger (Desktop als Feld mit `Strg K`, mobil als Icon), Sync-/Speicherstatus, Import, Sicherheitsmodus, Farbschema.
4. **Globale Suche** (Command-Palette auf Basis des vorhandenen Radix-Dialogs, Tastatur: `Strg/⌘ + K`, `/`, Pfeiltasten, Enter, Esc): Seiten, Einstellungsabschnitte, Aktionen (Import, Farbschema, Sicherheitsmodus, Assistent fragen), Kategorien, Sparziele und Buchungen (Händler, Verwendungszweck, Betrag). Treffer auf Buchungen öffnen `/umsaetze` und übergeben den Suchtext **ohne URL** über einen kleinen In-Memory-Kanal (`src/lib/ledger-search-bus.ts`). Im Sicherheitsmodus nur Seiten und Aktionen, keine Finanzdaten.
5. Bestehende Verträge bleiben: Landmark `complementary` für die Sidebar, `navigation "Hauptnavigation"`, Button „Navigation öffnen“, Profilregion, Einstellungen zuletzt, Skip-Link, Seitenübergänge.

Abnahme: Navigation auf 375/768/1440 px ohne horizontales Scrollen, Suche per Tastatur vollständig bedienbar, Sicherheitsmodus blendet Suchergebnisse mit Finanzdaten aus, Checks grün.

### M3 – Dashboard-Übersicht

**Ziel:** Karten-Dashboard mit Animationen.

Umfang:

1. `motion` (Framer Motion) einführen; kleine Client-Bausteine in `src/components/motion/` (`FadeIn`, `Stagger`, `AnimatedBar`) mit `MotionConfig reducedMotion="user"` und Berücksichtigung von `data-reduce-motion`.
2. Übersicht neu gegliedert:
   - Hero „Überschuss · Plan“ mit Aufteilungsbalken (bestehende Werte) und KPI-Leiste (Einnahmen, Ausgaben, Guthaben);
   - **Nettovermögen**-Karte mit Sparkline und Veränderung (aus `netWorthHistory`);
   - **Konten**-Karte (Girokonto, Amex offen, Trade Republic, Pockets aus den Bestandteilen des Nettovermögens);
   - **Budget-Fortschritt** des aktuellen Monats (variable Budgets Plan/Ist/Rest, Ampelzustand, Link auf `/umsaetze?month=…&group=…`);
   - **Sparziele** (Fortschritt, Zieldatum, Link auf `/sparen`);
   - bestehende Bereiche bleiben: geplante Ausgaben, KI-Einblicke, Ausgaben nach Kategorie.
3. Recharts neu gestylt: Donut mit Gesamtsumme im Zentrum, Flächen mit Verlauf, einheitliche Tooltips/Achsen, Wertetabelle bleibt zugänglich.

Abnahme: Alle Kennzahlen stammen aus vorhandenen Berechnungen (keine neuen Backend-Daten), Animationen respektieren reduzierte Bewegung, Sicherheitsmodus verdeckt alle Beträge, Checks grün.

### M4 – Transaktionsansicht

**Ziel:** Moderne Umsatzansicht, die Desktop-Tabelle und Handy-Kartenliste gleichwertig bedient.

Umfang (Datei `transactions.tsx` und Teilkomponenten):

1. TanStack Table bleibt Grundlage: ruhigere Tabellenoptik, Sticky-Kopf, sortierbare Spaltenköpfe mit Richtungsanzeige, Händlerlogo (`MerchantMark`) plus Name und Kategorie-Chip, Betrag mit Geldfarben.
2. Filter: Suche immer sichtbar, Filter (Monat, Kategorie, Konto, Status, Budgetgruppe, Tags) als Popover/Sheet; aktive Filter als entfernbare Chips mit „Alle zurücksetzen“.
3. Bulk-Aktionen: schwebende Aktionsleiste bei Auswahl (Kategorie zuordnen, Tag, Fixkosten, Ignorieren, Auswahl aufheben) – bestehende Aktionen, neue Präsentation.
4. Mobil (`< md`): nach Tagen gruppierte Kartenliste mit Tagessumme, Händlerlogo, Kategorie, Betrag; Auswahlmodus per Checkbox; Aktionen über bestehende Aktionsmenüs.
5. Übernahme der Suche aus der globalen Suche (ohne URL).
6. Alle bestehenden Funktionen bleiben: Prüfliste, Importablage, Händleralias/-suche, Tags und Tag-Summen, Sammelkorrektur mit Vorschau, Teilen, Ignorieren, Ansichtsexport, Budget-Drilldown, Pagination.

Abnahme: bestehende Umsatz-Tests grün, mobile Liste bei 375 px ohne horizontales Scrollen, Checks grün.

### M5 – Budget, Sparen, Gehalt & Steuern

**Ziel:** Die übrigen Fachseiten im neuen Design mit denselben Daten und APIs.

Umfang:

1. **Budget** (`budget-page`, `months`, `month-overview`, `budget-cards`, `month-plan-grid`, `month-plan-toolbar`): Seitenkopf mit Monats-Umschalter (Segmented Control), Budgetkarten mit animiertem Fortschritt und Ampelzustand, Monats-/Jahresplan-Tabelle mit neuen Tabellen-Tokens, Budget-Vorschläge als Karte.
2. **Sparen** (`savings-page`, `pockets`, `pocket-*`, `savings-goals`, `monthly-funding`, Trade Republic): Pocket-Karten mit Symbol/Farbe, Nettovermögen-Chart im neuen Chart-Theme, Sparziele als Karten mit Fortschritt, Zieldatum und Rate.
3. **Gehalt & Steuern** (`payroll-*`, `payslip-*`, `annual-sixth`, `tax-folder-panel`): Kennzahlenkarten, ruhigere Disclosure-Abschnitte, kompakte Hinweise am Ergebnis.
4. **Einstellungen** (`settings`, `settings-section` u. a.): Abschnitte als Karten, Abschnittsnavigation (Desktop sticky), gleiche Anker (`#profil`, `#jahreszeit`, `#sicherung` …).
5. **Login/Registrierung**: neues Layout im Design-System (Formularlogik unverändert).

Abnahme: dieselben API-Aufrufe und Datenflüsse, Tests grün, Dark Mode auf allen Seiten geprüft.

### M6 – Feinschliff

**Ziel:** Produktionsreife.

Umfang:

1. Lade-Skelette passend zum Seitenlayout (Shell-Ladezustand und `loading.tsx` für Routen).
2. Einheitliche leere Zustände (Symbol, Titel, Beschreibung, nächste Aktion).
3. Mikro-Interaktionen: Karten-Hover, Tap-Feedback, Toast-Stil (`sonner`) im Design-System, Fokusführung.
4. PWA-Manifest prüfen: Theme-/Hintergrundfarben, `id`, Shortcuts (Umsätze, Budget, Sparen), PNG-Icons 192/512 und maskable aus dem eigenen Logo (mit vorhandenem `sharp` erzeugt); weiterhin kein Service Worker (bewusste Entscheidung).
5. Performance: schwere Client-Teile (Assistent, Import/PDF/OCR, Charts) per `next/dynamic` nachladen, Lighthouse > 90 (Performance, Accessibility, Best Practices) mobil und Desktop. SEO-Kategorie ist durch das gewollte `noindex` begrenzt und wird separat ausgewiesen.
6. Responsive-Abnahme als Playwright-Test (`tests/responsive.spec.ts`): alle Hauptseiten bei 375, 768 und 1440 px ohne horizontales Scrollen, jeweils Hell und Dunkel.
7. API-Smoke-Test per `curl` gegen alle Routen unter `/api/` mit Vergleich der Statuscodes zur Basislinie.
8. `docs/REBUILD-SUMMARY.md` mit Änderungen, Prüfergebnissen und Push-/PR-Befehlen.

## 5. Neue Abhängigkeiten

| Paket | Zweck | Begründung |
| --- | --- | --- |
| `motion` (^12, installiert 12.43.0) | Karten- und Fortschrittsanimationen (M3, M5) | Vorgabe „Framer Motion“; `motion` ist der offizielle Nachfolger-Paketname von `framer-motion` (gleiche Bibliothek, `motion/react`). Nur in Client-Inseln, über `LazyMotion` mit `domAnimation` (kleineres Bundle); reduzierte Bewegung wird respektiert. Bewusst Major 12 (stabile, React-19-kompatible API); ein Wechsel auf die neuere Major-Version 14 ist ein separates Upgrade. |

Später ergänzt (Chat-Oberfläche, lokales Finanzwissen, Werkzeugkette, November 2026):

| Paket | Zweck | Begründung |
| --- | --- | --- |
| `sqlite-vec` (^0.1.9, Laufzeit) | Vektorsuche für das lokale Finanzwissen | Kleine native SQLite-Erweiterung ohne eigene Abhängigkeiten. Läuft im eingebauten `node:sqlite` im Arbeitsspeicher, kein eigener Server und keine Datenbankänderung. Die Alternative LanceDB brächte eine deutlich größere native Bibliothek mit eigenem Speicherformat. |
| `typescript` (^7.0.2, Entwicklung, ersetzt ^5) | Typprüfung | Der native TypeScript-7-Compiler prüft das ganze Projekt in rund 4 s, inkrementell in rund 1 s. Next.js 16.3 nutzt bei TS 7 automatisch die `tsc`-Kommandozeile. |
| `@biomejs/biome` (^2.6.7, Entwicklung) | Lint und Formatierung | Ersetzt `eslint`, `eslint-config-next` und `prettier`. `typescript-eslint` unterstützt TypeScript 7 nicht. Biome prüft die rund 970 Dateien in unter einer Sekunde. Barrierefreiheit prüft weiterhin axe in den Browsertests. |

Entfernt: `eslint`, `eslint-config-next`, `prettier`.

Chat-Effekte von Libraries.dev (November 2026), alle MIT, ohne eigene Laufzeit-Abhängigkeiten, nur React als Peer. Sie werden nur im Chat-Bundle geladen, das erst beim Öffnen des Assistenten nachkommt:

| Paket | Zweck | Begründung |
| --- | --- | --- |
| `thinking-orbs` (^0.3.2) | Denk-Orb in der Statuszeile | Ersetzt die eigenen drei Punkte; eine Animation je Art der Arbeit (suchen, rechnen, schreiben …). 2D-Canvas, ruht bei reduzierter Bewegung und außerhalb des sichtbaren Bereichs. |
| `bot-avatars` (^0.2.2) | Bots je Agent | Ersetzt das Stern-Symbol; Zustände `working`, `default` und `sleeping` zeigen, wer arbeitet. 2D-Canvas, eine gemeinsame Animationsschleife, kein WebGL. |
| `border-beam` (^1.4.1) | Rahmen um laufende Antwort und offene Bestätigung | Reines CSS mit `@property`, ohne Canvas; bei reduzierter Bewegung aus. |
| `metal-fx` (^2.0.11) | Metall-Ring um Senden/Stopp | Ein geteilter WebGL-Kontext für alle Instanzen. Liegt als Ebene hinter dem Knopf, damit der Knopf ohne WebGL weiter funktioniert; bei reduzierter Bewegung aus. |

Bewusst **nicht** hinzugefügt:

- LangChain, LlamaIndex, Chroma oder ein eigener Vektor-Server – Einbettung, Suche und Zusammenführung sind rund 300 Zeilen eigener Code.
- `cmdk` – die Command-Palette wird mit dem vorhandenen Radix-Dialog und einer zugänglichen Listbox gebaut.
- `vaul` – mobile Sheets nutzen den vorhandenen Dialog mit Sheet-Variante.
- Weitere shadcn-Pakete – shadcn-Komponenten sind kopierter Quellcode auf Basis des bereits installierten `radix-ui`.
- `lighthouse` – wird für die Messung ad hoc per `npx` ausgeführt, nicht in `package.json` aufgenommen.

Jede zusätzliche Abhängigkeit, die sich während der Umsetzung als nötig erweist, wird hier mit Begründung ergänzt, bevor sie installiert wird.

## 6. Prüfprotokoll

| Prüfung | Wann | Werkzeug |
| --- | --- | --- |
| Typprüfung, Unit-Tests, Build | nach jedem Meilenstein | `npm run typecheck && npm test && npm run build` |
| Lint | nach jedem Meilenstein | `npm run lint` |
| KI-Regression | nach jedem Meilenstein | bestehende Tests unter `src/lib/ai/` (Teil von `npm test`) |
| Responsive 375/768/1440 px, Hell/Dunkel | M2, M6 | Playwright (`tests/responsive.spec.ts`) |
| Barrierefreiheit | M6 | bestehender `tests/a11y.spec.ts` (axe) |
| API unverändert | M6 | `curl` gegen alle `/api/**`-Routen, Vergleich mit Basislinie |
| Lighthouse | M6 | `npx lighthouse` gegen `next start` |

## 7. Risiken

| Risiko | Gegenmaßnahme |
| --- | --- |
| Viele Komponententests prüfen Texte, Rollen und einzelne Klassen | Rollen/Namen/Texte beibehalten; Testanpassungen nur bei beabsichtigter Verhaltensänderung, begründet im Commit |
| Sicherheitsmodus wird durch neue Portals umgangen | Neue Overlays nutzen `Dialog`/`Popover` mit bestehenden `data-slot`-Selektoren; Suchergebnisse mit Finanzdaten nur im offenen Zustand |
| Saisonale Themes/Akzentfarben brechen | Token-Namen bleiben, saisonale Overrides werden in M1 gegen neue Tokens geprüft |
| Doppelte Navigationselemente verwirren Screenreader | Bottom-Bar enthält nur die vier Kernziele plus „Mehr“, Sidebar-Landmark bleibt eindeutig benannt |
| Performance durch Animationen | `motion` nur in Client-Inseln, Lazy-Loading schwerer Bereiche, Messung in M6 |
| 22 vorbestehende E2E-Fehlschläge (README) | Nicht Teil der Abnahmekriterien; neue Responsive-Spec und `a11y.spec.ts` müssen grün sein |
