# Finanzguru als konzeptionelle Referenz

Dieses Dokument hält fest, welche **Konzepte** aus öffentlich zugänglichen Informationen über die App Finanzguru als Inspiration für den UI-Umbau von Finanzblick dienen. Es werden **keine** Codes, Grafiken, Icons, Logos, Screenshots, Texte oder Markenelemente von Finanzguru übernommen. Farben, Formulierungen und Komponenten von Finanzblick bleiben eigenständig.

Recherchestand: November 2026.

## 1. Quellenlage

| Quelle | Inhalt |
| --- | --- |
| [finanzguru.de](https://finanzguru.de/) | Produktseite, Feature-Abschnitte (Übersicht, Ausgaben, Verträge, Budgets, KI-Chat) |
| [finanzguru.de – „Die Finanzguru App“](https://finanzguru.de/finanzwissen/finanzguru-app) | Herstellerbeschreibung der Bereiche und der Kategorisierung |
| [app.finanzguru.de](https://app.finanzguru.de/) | Nur Download-Seite (kein Web-Zugang) |
| [App Store – Finanzguru](https://apps.apple.com/de/app/finanzguru-konten-vertr%C3%A4ge/id1214803607) | Funktionsbeschreibung, u. a. „Analyse-Reiter“, Kontostandprognose, frei verfügbares Einkommen |
| [Google Play – de.dwins.financeguru](https://play.google.com/store/apps/details?id=de.dwins.financeguru&hl=de) | Funktionsbeschreibung, Kontenaggregation |
| [Hilfe-Center: Free vs. Plus](https://hilfe.finanzguru.de/de/articles/1509506) | Bereiche Statistik, Prognose, Budgets, Analysen, Sammlungen, Vertragserkennung |
| [Finanzwissen.de – Finanzguru-Test](https://finanzwissen.de/anbieter/finanzguru/test/) | Testbericht: Übersicht, Kategorisierung, Vertragsordner, Preisvergleich, Kritikpunkte |
| [neuebanken.de – Finanzguru-Test](https://www.neuebanken.de/finanzguru-test/) | Testbericht: Kategorien, kein Web-Zugang, Bankabdeckung |
| [Handelsblatt – Erfahrungen](https://www.handelsblatt.com/erfahrungen/finanzguru-test/) | Budgetwarnungen, Benachrichtigungen, Verbindungsprobleme |
| [WiWo – Vergleich](https://www.wiwo.de/vergleich/finanzguru-app/) | Benachrichtigungen, Verbindungsprobleme |
| [check-app.de – Erfahrungsbericht](https://www.check-app.de/2026/08/09/finanzguru-womit-verdient-die-app-eigentlich-geld-und-was-bekommt-sie-dafuer-von-mir/) | Kritischer Erfahrungsbericht (Upsell, Versicherungsservice) |

Gesuchte, aber nicht auffindbare Quellen: Stiftung Warentest, Finanztip, t3n, Computerbild (keine indexierten Testartikel gefunden).

**Grenzen der Recherche:** Finanzguru ist eine reine Mobile-App (`app.finanzguru.de` ist nur eine Download-Seite). Exakte Tab-Reihenfolge, Icons, Farbwerte, Eckenradien, Dark-Mode-Unterstützung, Tagesgruppierung der Umsätze und Händlerlogos sind aus Textquellen **nicht verifizierbar**. Solche Punkte sind unten als „Branchenmuster“ gekennzeichnet und stammen aus allgemeiner UX-Praxis von Finanz-Apps, nicht aus belegten Finanzguru-Details.

## 2. Beobachtete Muster und Übertragung auf Finanzblick

### 2.1 Layout und Navigation

- **Beleg:** Reiter-Konzept mit eigenen Bereichen für Übersicht, Ausgaben/Analyse, Verträge, Budgets (App-Store-Text „Analyse-Reiter“, Hilfe-Center-Struktur). Mehrere Konten werden in einer Ansicht aggregiert.
- **Übernommenes Konzept:** Wenige, klar benannte Hauptbereiche; auf dem Handy als **untere Navigationsleiste** mit vier Zielen plus „Mehr“, auf dem Desktop als **Sidebar** (Finanzguru bietet keine Desktop-Ansicht – hier geht Finanzblick bewusst weiter).
- **Finanzblick-Umsetzung:** Übersicht · Umsätze · Budget · Sparen in der Bottom-Bar, Gehalt & Steuern, Einstellungen und Profil hinter „Mehr“; Sidebar mit allen Zielen; Tablet-Rail mit Symbolen.
- **Eigene Ergänzung:** Globale Suche (Strg/⌘ + K) über Seiten, Einstellungen, Kategorien, Sparziele und Buchungen – in den Quellen für Finanzguru nicht erwähnt.

### 2.2 Dashboard / Übersicht

- **Beleg:** Gesamtsaldo aller Konten, **Kontostandprognose** auf Basis erkannter Verträge, **„frei verfügbares Einkommen“** bis Monatsende, Hinweis auf noch kommende Buchungen.
- **Übernommenes Konzept:** Eine Hero-Kennzahl, die beantwortet „Wie viel bleibt mir?“, darunter kompakte Karten für Vermögen, Konten, Budget-Fortschritt und Sparziele, die jeweils zur Detailseite führen.
- **Finanzblick-Umsetzung:** Bestehender „Überschuss · Plan“ bleibt die Hero-Kennzahl (inkl. Aufteilungsbalken); neue Karten **Nettovermögen** (mit Verlauf), **Konten** (Girokonto, Amex offen, Trade Republic, Pockets aus `netWorthHistory`), **Budget-Fortschritt** (variable Budgets, Plan vs. Ist), **Sparziele** (Fortschritt je Ziel). Alle Werte stammen aus den vorhandenen Berechnungen (`calculateDashboard`, `net-worth`, `goals`, `variable-budgets`).

### 2.3 Umsätze

- **Beleg:** Automatische Kategorisierung jeder Buchung, manuelle Korrektur „lernt mit“.
- **Branchenmuster (nicht belegt):** Gruppierung nach Tag, Händlerlogo links, Betrag rechts mit Farbcodierung (Einnahmen grün, Ausgaben neutral), Suchfeld und Filter-Chips, Detailansicht als Sheet.
- **Finanzblick-Umsetzung:** Desktop-Tabelle (TanStack Table, bereits vorhanden) mit Händlerlogo, Kategorie-Chip und Geldfarben; mobil eine **nach Tagen gruppierte Kartenliste** mit Tagessumme; aktive Filter als entfernbare Chips; Sammelaktionen in einer schwebenden Aktionsleiste. Bestehende Funktionen (Prüfliste, Händleralias, Tags, Teilen, Ignorieren, Export, Drilldown) bleiben vollständig.

### 2.4 Budgets und Sparen

- **Beleg:** Budgets überwachen Ausgaben und warnen bei Überschreitung; „Sammlungen“ bündeln Buchungen unabhängig von Zeitraum (vergleichbar mit Finanzblick-Tags).
- **Übernommenes Konzept:** Fortschrittsbalken mit klarer Restbetrag-Formulierung („noch X € frei“ / „X € überschritten“), Ampelzustand (im Rahmen, knapp, überschritten).
- **Finanzblick-Umsetzung:** Budgetkarten mit animiertem Fortschritt und Zustandsfarbe aus Status-Tokens; Sparziele mit Fortschritt, Zieldatum und monatlicher Rate. Monats-/Jahresplan (`month-plan-grid`) bleibt als Tabelle erhalten und wird nur visuell modernisiert.

### 2.5 Analysen

- **Beleg:** Trends und Ausgabenanalyse in eigenem Bereich (teils Premium).
- **Finanzblick-Umsetzung:** Kategorie-Donut und Verlaufsdiagramme bleiben auf Übersicht/Sparen, einheitlich gestylt (gemeinsamer Tooltip, Achsen, Farben aus `--chart-*`), jeweils mit zugänglicher Wertetabelle (bestehende Anforderung aus `docs/project-analysis-2026-10-12.md`).

### 2.6 Verträge / Fixkosten

- **Beleg:** Automatischer Vertragsordner mit nächster Abbuchung und Kündigungsfrist; Preisvergleich mit Farbskala.
- **Finanzblick-Umsetzung:** Fixkosten-Erkennung und -Plan existieren bereits (`fixed-plan`, `fixed-cost-schedule`, KI-Einblicke zu Abos). Im Umbau nur visuelle Überarbeitung (Status-Chips „gebucht / fällig / offen“); keine neue Backend-Funktion (out of scope).

## 3. Bewusste Abgrenzung (aus Kritikpunkten gelernt)

| Kritik an Finanzguru (Quelle) | Konsequenz für Finanzblick |
| --- | --- |
| Gratisversion stark eingeschränkt, Upsell-Druck (Finanzwissen, check-app) | Keine Paywalls, keine Werbeflächen, keine Upsell-Banner |
| Zu viele/aufdringliche Benachrichtigungen (Handelsblatt, WiWo) | Bestehende opt-in-Benachrichtigungen bleiben; keine neuen Pushs |
| Ungenaue Kategorisierung kleiner Händler (Finanzwissen, neuebanken) | Prüfliste und „Warum diese Kategorie?“ bleiben prominent; KI-Logik unverändert |
| Kein Desktop-/Web-Zugang (Finanzwissen, neuebanken) | Vollwertige Desktop-Ansicht mit Sidebar und Tabellen, gleiche Funktionen mobil |
| Bargeld schlecht abbildbar (Finanzwissen) | Bestehende manuelle Buchungen bleiben im Umsatzbereich direkt erreichbar |

## 4. Übernommene Konzepte (Zusammenfassung)

1. Eine Hero-Kennzahl „Was bleibt frei?“ oben auf der Übersicht.
2. Karten-Dashboard: Vermögen, Konten, Budget-Fortschritt, Sparziele – jede Karte verlinkt ihre Detailseite.
3. Bottom-Navigation (mobil) mit vier Kernbereichen plus „Mehr“; Sidebar auf dem Desktop.
4. Umsätze mobil als nach Tagen gruppierte Liste mit Händlerlogo, Kategorie und farbcodiertem Betrag.
5. Filter als Chips, Suche immer sichtbar.
6. Budget-Fortschritt als Balken mit Restbetrag-Formulierung und Ampelzustand.
7. Sparziel-Fortschritt mit Zieldatum und Monatsrate.
8. Ruhige, kartenbasierte Optik mit großzügigen Radien und viel Weißraum; Dark Mode als gleichwertiger Modus.
9. Konversationeller Einstieg (bestehender Finanz-Assistent) bleibt als schwebende Schaltfläche erreichbar.
10. Transparenz statt Druck: keine Upsells, Warnungen nur, wo sie handlungsrelevant sind.
