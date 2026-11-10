# Gehalt & Steuern, Einstellungen, Bank-Logos – Zusammenfassung

Umsetzung von [`SALARY-SETTINGS-PLAN.md`](SALARY-SETTINGS-PLAN.md). Der Plan wurde ohne ausdrückliche Freigabe
umgesetzt (der Nutzer war nicht erreichbar und bat um selbstständiges Arbeiten); dabei galten alle neun Annahmen
aus Abschnitt 7 des Plans.

## Commits und Branches (gestapelt auf `dialogs/m4-migration`)

| Branch | Commit | Inhalt |
|---|---|---|
| `salary/m1-settings` | `69eb39d` | Plan |
| `salary/m1-settings` | `fb09444` | M1 Einstellungen in Kategorien, Bankverbindungen, Bank-Logos |
| `salary/m2-payroll` | `76eba03` | M2 Gehalt & Steuern neu |
| `salary/m3-goal-tr` | `6c35a0f` | M3 Trade Republic als Ausnahme in der Sparziel-Verteilung |
| `salary/m3-goal-tr` | `ff82ebc` | E2E-Spec `salary-settings.spec.ts`, Kontrast- und Tastaturfixes, Memoisierung |
| `salary/m3-goal-tr` | `49587b7` | Bottom Sheet beim schnellen Wiederöffnen, `payroll-workspace.spec.ts` aktualisiert |
| `salary/m3-goal-tr` | `4c2d2aa` | Profil-E2E folgt den Einstellungs-Kategorien |
| `salary/m3-goal-tr` | (dieser Commit) | Zusammenfassung |

Der GitHub-Remote war wie in den vorigen Runden nicht erreichbar; es wurde nichts gepusht und es gibt keine Pull
Requests. Jeder Branch baut auf dem vorigen auf und kann als eigener PR geöffnet werden.

## M1 – Einstellungen und Bank-Logos

- **Fünf Kategorien** (`settings-sections.ts`): Konto · Banken & Verbindungen · Darstellung ·
  Mitteilungen & Privatsphäre · Daten, jede mit Symbol und einer kurzen Zusammenfassung in der Navigation
  (z. B. Logos und „3 Banken“, „Backup vor 2 Tagen“, „Sichtschutz automatisch“). Ab 1024 px zweispaltig (Suche + Navigation links, Inhalt
  rechts), darunter eine Übersichtsliste mit Drill-in und „Alle Einstellungen“ zurück.
- **Adressen**: `?bereich=<kategorie>` und Deep Links auf Abschnitte (`/einstellungen#bankverbindung`,
  `#sicherung` …) öffnen die passende Kategorie; Zurück im Browser funktioniert auf dem Handy. Die globale
  Suche springt ebenfalls direkt in die Kategorie. Die Suche in den Einstellungen findet über alle Kategorien.
- **Weniger Text**: Abschnittsbeschreibungen stehen als ⓘ-Tooltip (`InfoTip`) neben der Überschrift statt als
  Absatz; Sichtschutz als Segmentauswahl; Sicherung und Gefahrenzone neu gegliedert.
- **Bankverbindungen** (`bank-connections.tsx`): je Verbindung Logo, Name, Status-Badge (Aktiv · Freigabe
  endet in n Tagen · Pausiert · Testmodus), maskierte IBAN, Menü (Freigabe erneuern, Trennen mit Bestätigung),
  sichtbarer „Erneuern“-Knopf bei ablaufender Freigabe, leerer Zustand, eingeklappte Einrichtungsanleitung.
- **Bank hinzufügen** (`bank-picker.tsx`): Premium-Dialog mit Land (Segmentauswahl) und durchsuchbarer
  Combobox; Logo vor jedem Banknamen, Gruppen „Deine Banken“ / „Weitere Banken“, Tastaturnavigation.
- **Logos** (`src/lib/banks/`, `/api/banks/logo`, `BankLogo`): Reihenfolge Enable-Banking-Verzeichnis →
  offizielle Website der Bank (nur Domains aus der eigenen Bankliste), PNG-Neucodierung, Cache neben der
  Kontodatenbank (`bank-logos/`, Fehlschläge 7 Tage gemerkt, max. 300 Dateien, 30 Abrufe/Minute/Benutzer).
  Sofort sichtbar ist immer ein farbiges Monogramm; das Logo blendet nach dem Laden darüber. Kein Clearbit
  oder Brandfetch, keine Logo-Dateien im Repository. Logos erscheinen außerdem bei Pocket-Salden, im
  Trade-Republic-Saldo-Dialog, in den Buchungsdetails und in der Buchungsauswahl des Vertrags-Dialogs.

## M2 – Gehalt & Steuern

- **Auswahl** Steuerjahr · Dienstverhältnis · **Monat** (Standard: letzte Abrechnung, Pfeile oder Liste);
  fehlende Monate und offene Prämienzuordnungen als kleiner Hinweis-Chip mit Details im Popover.
- **Brutto → Netto** des Monats zuerst: großes Netto, daneben Brutto, Lohnsteuer und SV mit Anteil, darunter
  ein gestapelter Balken (baut sich einmal auf, respektiert „Bewegung reduzieren“) mit Legende. „Sonstige
  Abzüge“ nur, wenn alle vier Werte belegt und größer als 0 sind; fehlende Werte heißen „nicht auf der
  Abrechnung“ statt 0. Sonderzahlungsmonate zeigen laufend und Sonderzahlung getrennt. Chips vergleichen mit
  dem Vormonat und – sobald vorhanden – dem Vorjahresmonat.
- **Jahr bisher**: Summen Brutto/Netto/Lohnsteuer/SV, durchschnittlicher Abzugssatz, Monatsleiste mit zwölf
  Säulen (Sonderzahlung markiert, Prognose gestrichelt), Klick wählt den Monat.
- **Sonderzahlung & Jahressechstel**: nächste modellierte Sonderzahlung und ein Balken „verbraucht x von y ·
  Rest z“ (Überhang rot); alle bisherigen Details (Abrechnungsstand, Sechstel-Schätzung, Prämien-Spielraum,
  1.000-€-Steuerbeispiel) unter **Mehr Details**.
- **Monate**: kompakte Liste aller zwölf Monate (fehlende und geschätzte markiert, Sonderzahlung als Punkt),
  darin die aufklappbare Monatsprognose; danach **Abrechnungen** (Import) und die eingeklappte
  **Steuer-Mappe**. Ohne Abrechnungen ist der Import der Einstieg der Seite.
- `src/lib/payroll-overview.ts` bildet nur Summen, Differenzen und Anteile vorhandener Werte; Steuerrechnung,
  Import und Prognose sind unverändert. Die Analyse ist memoisiert (Monatswechsel rechnet nicht neu).

## M3 – Trade Republic in der Sparziel-Verteilung

- Liegen Trade-Republic-Kontostände vor, zeigt der Schritt **Konten** „Trade Republic · Notgroschen“ mit Logo,
  Zinssatz und Kontoregel. Es bleibt gesperrt, bis man es pro Ziel mit **Als Ausnahme einbeziehen** freigibt;
  **Mindestens behalten** ist mit dem Notgroschen-Ziel vorbelegt.
- Der Planer (`planGoal`, neue „späte“ Konten) nutzt Trade Republic als letzte Quelle und so spät wie möglich:
  mit Zieldatum im letzten nötigen Monat, bei „So schnell wie möglich“ im ersten Monat, in dem es reicht.
  Andere Konten und die Überschuss-Verteilung sind unverändert (bestehende Tests grün).
- Mini-Tabelle: Monat der Umbuchung wählbar (für alle Pocket-Umbuchungen), Betrag überschreibbar, auf dem
  Handy steht das Konto unter dem Monat. Ein Hinweis nennt die entgangenen Zinsen nach KESt bzw. dass bis zum
  Termin weiter verzinst wird. Die Übersicht weist den Trade-Republic-Anteil getrennt aus (Balken und
  Monatsdiagramm).
- Gespeichert als `funding.exceptions: [{ account, keep }]` (optional, additiv, keine Schemamigration nötig);
  Trade Republic wird nie in `excluded.accounts` geschrieben. Überwiesen wird weiterhin nichts automatisch.

## Prüfungen

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run build` | Exit 0 nach jedem Meilenstein und am Ende |
| `npm test` | 4.931 bestanden, 5 erwartete Fehlschläge, 3 übersprungen (wie zuvor) |
| Neue Unit-/Komponententests | Bankverzeichnis 14, Logo-Auflösung 11, Logo-Route 8, `BankLogo` 5, Bankverbindungen 3, `payroll-overview` 14, Fokus-Karte 7, Jahr/Monate 3, Planer +5, Sparziel-Dialog +2, Dialog-Scrollfokus 1; Einstellungs-Tests auf Kategorien umgestellt |
| `tests/salary-settings.spec.ts` (Browsermodus) | 15/15 – Gehalt & Steuern und Einstellungen bei 375/768/1440 px hell und dunkel (kein horizontales Scrollen, axe ohne kritische/schwere Treffer, Monatswechsel, Kategorien, Deep Link), leerer Zustand, Sparziel mit Trade-Republic-Ausnahme |
| `tests/salary-settings.spec.ts` (Kontomodus, `PLAYWRIGHT_LOCAL_ADMIN=1`) | 2/2 – `#bankverbindung`, Logos und Monogramm, Bank-hinzufügen-Suche, axe |
| `premium-dialogs`, `a11y`, `responsive` | grün (zusammen mit der neuen Spec 41 bestanden) |
| `tests/payroll-workspace.spec.ts` (Kontomodus) | 10/10 bei 1440/390/320 px (vorher 7 von 10 rot, siehe unten) |
| `tests/profile.spec.ts` Desktop | grün |
| Design-Detektor (impeccable) auf allen geänderten UI-Dateien | keine Befunde |
| Screenshots 375/768/1440 px hell/dunkel | geprüft, Befunde behoben (u. a. Netto-Zahl am Tablet, „Rest“ umbrechend, Mini-Tabelle am Handy, leere „Sonstige Abzüge 0 %“) |

Lighthouse (Performance, 3 Läufe, Median; Aufbau wie in `PERFORMANCE.md`, synthetischer Stand mit zehn
Abrechnungen):

| Seite | Mobil vorher | Mobil nachher | Desktop vorher | Desktop nachher |
|---|---|---|---|---|
| `/gehalt-steuern` | 47 (35/47/51) | 47 (37/51/47) | 94 | 93 |
| `/einstellungen` | – | 78 (77/81/78) | – | 99 |

Mobil schwanken die Läufe stark; die Hauptlast ist wie in `PERFORMANCE.md` beschrieben der gemeinsame
Rechenkern beim Hydrieren, nicht die neuen Komponenten. Eine erste Messung nach M2 lag bei 42; nach der
Memoisierung der Gehaltsanalyse wieder auf dem Ausgangswert.

## Zusätzlich behoben

- **Kontrast**: Status-Badges (Aktiv, Pausiert u. a.) hatten im hellen Modus 4,38:1 bzw. 4,21:1; die Textfarbe
  der weichen Badges ist im hellen Modus jetzt dunkler (über 4,5:1), dunkel unverändert.
- **Tastatur**: Überlaufende Dialog-Inhalte ohne Bedienelemente (z. B. Sparziel-Übersicht auf dem Handy) werden
  zum Tab-Stopp mit Fokusrahmen und lassen sich per Tastatur scrollen.
- **Bottom Sheet**: Wurde ein Sheet geöffnet, während es noch hinausglitt (z. B. „Abrechnungen ersetzen?“
  abbrechen und sofort erneut dieselbe PDF wählen), blieb es unterhalb des Bildschirms. Es gleitet jetzt
  wieder herein (Fehler aus der Dialog-Runde).
- **`payroll-workspace.spec.ts`** schlug schon vor dieser Runde in 7 von 10 Fällen fehl (geprüft auf
  `fb09444`): Jahressechstel liegt eingeklappt, die Importmeldung hat einen Budget-Zusatz, und das Entfernen
  einer Abrechnung lässt die ins Budget übernommene Einnahme bewusst stehen. Die Erwartungen sind angepasst.

## Abweichungen vom Plan

- Freigabe des Plans nicht abgewartet (Nutzer nicht erreichbar).
- Logo-Route liefert im lokalen Browsermodus 404, dort erscheint nur das Monogramm (kein Server-Cache ohne
  Konto). Kein Wikidata-Fallback; breite Schriftzug-Logos verlieren gegen quadratische Symbole.
- Kein Bank-Logo in den Zeilen der Umsatztabelle: dort steht bereits das Händler-Logo.
- Eine Prämie mit offener Sechstelzuordnung zählt zum Brutto (sonst wäre Netto größer als Brutto).
  Lohnsteuer und SV gelten nur dann als vollständig, wenn die Sonderzahlung ihre eigenen Werte ausweist;
  sonst steht „ohne Sonderzahlung“ am Anteil.
- „Belegt“ ist in der Monatsliste nur für Screenreader ausgeschrieben; sichtbar markiert sind fehlende und
  geschätzte Monate.
- Der Umbuchungsmonat ist nicht nur für Trade Republic, sondern für alle Pocket-Umbuchungen wählbar.

## Offene Punkte

- **Logos** für Bank Austria, Trade Republic, Amex, easybank, Revolut, comdirect und bunq sind über
  Enable Banking bzw. die Website nicht zuverlässig abrufbar; dort bleibt das Monogramm.
- **Vorjahresvergleich** erscheint erst mit Abrechnungen aus 2027 (das Schema kennt nur 2026/2027).
- **Monatsliste**: Zeilen klappen nicht auf; die Prognosedetails bleiben im eigenen Aufklappbereich.
- **Mobile Performance** von `/gehalt-steuern` bleibt bei ~47 (unverändert gegenüber vorher); Verbesserung
  bräuchte einen Umbau des gemeinsamen Rechenkerns (siehe `PERFORMANCE.md`).
- **Ältere E2E-Specs** zielen weiter auf Stände vor dem UI-Umbau und waren schon vorher rot:
  `settings-design.spec.ts` (Sparziele unter `/einstellungen`) und der mobile Teil von `profile.spec.ts`
  („Navigation öffnen“ gibt es seit der Bottom-Bar nicht mehr), dazu die in der README genannten Specs.
- Die Bank-Sektion existiert nur im Kontomodus; ihre E2E-Tests laufen nur mit `PLAYWRIGHT_LOCAL_ADMIN=1` und
  isolierter Testdatenbank.
- Kein Push und keine Pull Requests, weil der Remote nicht erreichbar ist.
