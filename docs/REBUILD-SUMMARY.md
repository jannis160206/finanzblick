# UI/UX-Umbau – Zusammenfassung

Der Umbau nach `docs/REBUILD-PLAN.md` ist abgeschlossen. Alle sechs Meilensteine liegen als gestapelte Branches mit je einem Commit vor; Recherche und Plan stehen in einem vorangestellten Doku-Commit.

> Freigabe des Plans: Die Rückfrage zur Planfreigabe wurde gestellt; da keine Antwort möglich war, wurde der Plan wie dokumentiert umgesetzt.

## 1. Branches und Commits

| Meilenstein | Branch | Commit | Basis |
| --- | --- | --- | --- |
| Recherche & Plan | `rebuild/m1-design-system` | `b8f1713` | `main` (`a966872`) |
| M1 Design-System | `rebuild/m1-design-system` | `c7b4d22` | – |
| M2 App-Shell | `rebuild/m2-app-shell` | `89f7b44` | M1 |
| M3 Dashboard | `rebuild/m3-dashboard` | `24f47ac` | M2 |
| M4 Transaktionen | `rebuild/m4-transactions` | `77fd8b5` | M3 |
| M5 Budget, Sparen, Gehalt & Steuern | `rebuild/m5-pages` | `0f207ba` | M4 |
| M6 Feinschliff | `rebuild/m6-polish` | dieser Commit | M5 |

### Push und gestapelte Pull Requests

Aus der Arbeitsumgebung war `github.com/jannis160206/finanzblick` nicht erreichbar (`gh` ist mit einem anderen Konto angemeldet, `git ls-remote` meldet „Repository not found“). Mit Zugriff auf das Repository:

```sh
git push -u origin rebuild/m1-design-system rebuild/m2-app-shell rebuild/m3-dashboard \
  rebuild/m4-transactions rebuild/m5-pages rebuild/m6-polish

gh pr create --base main                     --head rebuild/m1-design-system --title "M1: Design-System"            --fill
gh pr create --base rebuild/m1-design-system --head rebuild/m2-app-shell     --title "M2: App-Shell"                --fill
gh pr create --base rebuild/m2-app-shell     --head rebuild/m3-dashboard     --title "M3: Dashboard"                --fill
gh pr create --base rebuild/m3-dashboard     --head rebuild/m4-transactions  --title "M4: Transaktionsansicht"      --fill
gh pr create --base rebuild/m4-transactions  --head rebuild/m5-pages         --title "M5: Budget, Sparen, Gehalt"   --fill
gh pr create --base rebuild/m5-pages         --head rebuild/m6-polish        --title "M6: Feinschliff"              --fill
```

`--fill` übernimmt die ausführlichen Commit-Messages als PR-Beschreibung.

## 2. Änderungen je Meilenstein

**M1 Design-System** – Getönte Neutral-Skala, Status-Tokens (`success`, `warning`, `info` inkl. `-soft`), Geldfarben (`money-in`/`money-out`), Schatten-Tokens (`shadow-card/raised/overlay`), Radius 12 px, Typostufen `text-title`/`text-display`, Utility `amount`. Neue shadcn-artige Primitive: `Card`, `Badge`, `Progress`, `Separator`, `Kbd`, `SegmentedControl`, `Stat`. Gemeinsames Recharts-Theme. App-weiter `ThemeProvider` (Hell/Dunkel/System, auch Login/Registrierung). Seitentitel ohne Eyebrow-Kicker. Details: `docs/DESIGN-TOKENS.md`.

**M2 App-Shell** – Shell in `src/components/shell/` aufgeteilt. Bottom-Bar unter 768 px (Übersicht, Umsätze, Budget, Sparen, Mehr), Icon-Rail 768–1023 px, Sidebar ab 1024 px. Header mit Suchfeld, Speicherstatus, Import, Sichtschutz, Farbschema. Globale Suche (Strg/⌘ K, `/`) über Seiten, Aktionen, Buchungen, Kategorien, Sparziele, Einstellungen und „Assistent fragen“; Suchtexte gelangen ohne URL in die Umsätze; im Sichtschutz keine Finanzdaten.

**M3 Dashboard** – Hero „Überschuss · Plan“, KPI-Leiste, Budget-Karte (fünf am stärksten ausgeschöpfte Positionen mit Ampel und Drilldown), Nettovermögen mit Verlauf und Konten, Sparziele mit Fortschritt. Animationen mit `motion` (Fortschrittsbalken füllen sich gestaffelt, reduzierte Bewegung respektiert). Donut mit Gesamtsumme, Anteilsbalken, unterscheidbare Diagrammfarben.

**M4 Transaktionen** – TanStack-Tabelle mit Kategorie-Chips (Farbpunkt je Kategoriegruppe), Geldfarben, eindeutigen Sortierpfeilen. Klebende Auswahlleiste für Sammelaktionen. Aktive Filter als Chips; mobil Filter hinter einem Button mit Zähler. Mobile Kartenliste nach Tagen gruppiert mit klebender Tageszeile und Tagessumme.

**M5 Seiten** – Budget mit `SegmentedControl`, Symbolen für Budgetpositionen und animierten Balken; Sparen mit Vermögenskacheln und Veränderungs-Badge; Gehalt & Steuern mit kompakter Auswahl im Seitenkopf und hilfreichem leeren Zustand; Einstellungen ohne Versal-Kicker; Login/Registrierung folgen Hell/Dunkel.

**M6 Feinschliff** – Layout-nahe Lade-Skelette (Shell, Routen-`loading.tsx`, Suspense), einheitliche leere Zustände inkl. 404/Fehlerseite, Tap-Feedback in der Bottom-Bar. PWA: `id`, PNG-Icons 192/512, maskierbares Icon, Apple-Icon, Shortcuts (Umsätze, Budget, Sparen), Kategorien; Icons reproduzierbar per `npm run pwa:icons`. Performance: eigene Routen je Bereich statt einer dynamischen Sammelroute (Code-Splitting), Assistent, Diagramme und Motion-Features werden nachgeladen, Nettovermögen auf der Übersicht nach dem ersten Paint berechnet.

## 3. Abnahmekriterien

| Kriterium | Ergebnis | Nachweis |
| --- | --- | --- |
| API-Routen unverändert | ✅ 57/57 Proben identisch zur Basislinie | `curl`-Smoke-Test gegen Produktions-Build (anonym und angemeldet, GET plus POST mit leerem Body) vor und nach dem Umbau; `git diff main -- src/app/api` leer |
| `npm run typecheck`, `npm test`, `npm run build` | ✅ Exit 0 nach jedem Meilenstein | zuletzt 264 Testdateien, 4 718 Tests grün (5 erwartete Fehlschläge wie zuvor); zusätzlich `npm run lint` grün |
| 375 / 768 / 1440 px ohne horizontales Scrollen | ✅ | neuer Playwright-Test `tests/responsive.spec.ts` (alle sechs Seiten, Hell und Dunkel, prüft auch Bottom-Bar/Rail/Sidebar) |
| Keine Regression in der KI-Kategorisierung | ✅ | 10 Testdateien / 95 Tests unter `src/lib/ai/` grün; `src/lib/ai/` und `src/lib/import/` unverändert |
| Dark Mode auf allen neuen Seiten | ✅ | Responsive- und axe-Tests in beiden Farbschemata; Login/Registrierung folgen jetzt dem Schema |
| Neue Abhängigkeiten dokumentiert | ✅ | nur `motion` (Begründung in `docs/REBUILD-PLAN.md`) |

Barrierefreiheit: `tests/a11y.spec.ts` (axe, WCAG 2.0–2.2 A/AA) auf fünf Seiten in Hell und Dunkel ohne Befund; Lighthouse Accessibility 100 auf allen gemessenen Seiten.

Nicht verändert: `src/lib/ai/`, `src/lib/import/`, `src/lib/server/` (Datenbank, Auth), `src/app/api/`, `deploy/`, `.env*`, `.github/`.

## 4. Lighthouse

Produktions-Build (`next start`, Kontomodus mit temporärer Datenbank), Lighthouse 13.6 mit Chromium; „vorher“ = `main` @ `a966872` im gleichen Aufbau.

| Seite | Desktop vorher → nachher (Performance) | Mobil vorher → nachher (Performance) | Accessibility | Best Practices | SEO |
| --- | --- | --- | --- | --- | --- |
| `/` | 94 → **95** | 53 → **55** | 100 | 96 | 54 |
| `/umsaetze` | 93 → **96** | 53 → **61** | 100 | 96 | 54 |
| `/budget` | 93 → **96** | 53 → **59** | 100 | 96 | 54 |

- **Desktop erfüllt > 90** in Performance, Accessibility und Best Practices.
- **SEO 54** ist gewollt: Die App setzt `robots: noindex` (privates Finanzdashboard) und hat keine `robots.txt`.
- **Best Practices 96**: Der einzige Abzug ist eine Konsolenmeldung (HTTP 403), die nur durch den Messaufbau entsteht (HTTPS-Origin konfiguriert, lokal per HTTP ausgeliefert); identisch bei `main`.
- **Mobil bleibt unter 90.** Der Umbau verbessert die simulierte Mobilwertung (langsames 4G, 4× CPU-Drosselung) gegenüber `main`, das Ziel wird aber nicht erreicht. Ursache ist die bestehende Architektur: Alle Inhalte entstehen erst nach Hydration im Browser, nachdem Kontodaten geladen, mit `zod` validiert und vom Rechenkern ausgewertet wurden (React DOM und App-Logik-Chunk dominieren die Hauptthread-Zeit). Für > 90 mobil wären Änderungen an Datenfluss und Logik nötig, die laut Auftrag außerhalb des Umfangs liegen:
  1. Initiale Kontodaten serverseitig rendern statt per `/api/finance` im Browser nachzuladen.
  2. Schema-Validierung des Gesamtzustands serverseitig ausführen bzw. im Browser lazy laden.
  3. `FinanceProvider` aufteilen (Import-, Review- und KI-Pfade erst bei Bedarf laden).

## 5. Tests

Neu: `shell/global-search.test.tsx`, `dashboard/dashboard-cards.test.tsx`, `transactions-toolbar-mobile.test.tsx`, `tests/responsive.spec.ts`, Erweiterungen in `manifest.test.ts` und `payroll-navigation.test.tsx` (Weiterleitungen alter Adressen, 404).

Angepasst, weil sich beabsichtigtes Verhalten geändert hat:

| Test | Änderung | Grund |
| --- | --- | --- |
| `finance-ui.test.tsx` | erwartet keinen Kicker-Absatz mehr | Seitentitel ohne Eyebrow (M1) |
| `category-donut.test.tsx` | ohne `tooltipStyle`-Prop | gemeinsames Chart-Theme (M1) |
| `profile-navigation.test.tsx` | öffnet den Drawer über „Mehr“ in der Bottom-Bar | Hamburger-Menü durch Bottom-Bar ersetzt (M2) |
| `payroll-navigation.test.tsx` | importiert die eigene Route `gehalt-steuern/page` | Code-Splitting je Bereich (M6) |

## 6. Hinweise

- Die bestehenden 22 vorab fehlschlagenden E2E-Tests (README) wurden nicht bearbeitet; ausgeführt wurden `tests/responsive.spec.ts` und `tests/a11y.spec.ts`.
- Der Design-Detektor (impeccable) meldet nur den bestehenden „Denkt nach“-Shimmer des Assistenten (Farbverlauf in Text als Ladezustand, bei reduzierter Bewegung aus); bewusst unverändert.
- Alte Adressen (`/monate`, `/plan`, `/pockets`, `/assistent`) leiten weiterhin um; unbekannte Bereiche zeigen die neue 404-Seite.
