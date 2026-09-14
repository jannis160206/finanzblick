# Finanzblick

## Installation

Node.js 22.13+ oder 24 LTS.

```sh
npm install
```

## Entwicklung

```sh
npm run dev
```

http://localhost:3000

## Kontoauszüge

- Unter **Umsätze** CSV-/XLSX-Dateien oder Amex-PDFs ablegen. Raiffeisen-Umsatzlisten ohne Kopfzeile und konsolidierte Revolut-Auszüge werden erkannt.
- Sicher zugeordnete Buchungen werden automatisch gespeichert. Nur unklare Zeilen und Fixkostenänderungen erscheinen in der Prüfliste. Schließen der Prüfliste macht bereits gespeicherte Buchungen nicht rückgängig.
- Datum, Text und Betrag lassen sich dort korrigieren; Kategorie und Pocket zuordnen, dann **Speichern** oder **Überspringen**. Nicht erledigte Einträge bleiben bis zum Verlassen der Umsatzseite unter „Einträge prüfen“ erreichbar; nach einem Neuladen den Auszug erneut ablegen.
- Gehalt, Leasing, Vollkasko, Haftpflicht und Handyvertrag werden mit dem Monatsraster abgeglichen, nicht doppelt gebucht. Abweichungen über 0,05 € benötigen **Ja/Nein**. Ja übernimmt den Betrag ab dem Buchungsmonat bis Ende 2027; Nein behält die Monatswerte. Entscheidungen bleiben auch in Excel-Sicherungen erhalten.
- PDF-Text wird lokal im Browser extrahiert; keine Kontoauszüge werden hochgeladen. Versetzte Beträge und CR-Gutschriften werden unterstützt. Unklare Textzeilen kommen in die Prüfliste. Für reine Scans ist keine OCR enthalten.

## Automatische Planung

Beim Laden und nach jedem erfolgreichen Import werden Stichtag, variabler Plan und Pocket-Verteilung aktualisiert. Die vier abgeschlossenen Monate verschieben sich automatisch; auch ein geöffneter Tab erkennt den Tageswechsel. Die Übersicht zeigt die Verteilung für Motorrad, Sparkonto, Urlaub und Notgroschen in einer Zeile.

Lebensmittel, Mittagessen, Tanken, G2A und Ausgehen werden ab dem aktuellen Monat automatisch berechnet. Manuelle Einzelwerte im Monatsraster sind explizite Overrides; ein leeres Feld aktiviert wieder „Auto“. Gesamtbudget-Overrides bleiben ebenfalls erhalten. Der unterstützte Planungshorizont bleibt 2026–2027.

## Erscheinungsbild

Unter **Einstellungen → Jahreszeit / Erscheinungsbild** stehen sechs Akzentfarben und ein Farbwähler bereit. Die persönliche Farbe gilt für Logo, Navigation, Buttons, Diagrammakzent und Fokusmarkierungen – auch unter saisonalen Themes. Text und Buttons erhalten bei Bedarf kontrastgerechte Farben.

**Automatisch** folgt dem lokalen Kalender, **Immer Standard** deaktiviert saisonale Details, **Festes Theme** bietet Default, Halloween und Weihnachten. Saisonale Modi ergänzen nur eine leichte Tönung von Header/Sidebar, wenige statische Icons und ein Detail am ursprünglichen Finanzblick-Logo. Tabellen bleiben neutral; es gibt keine Szenen, Overlays oder Partikelanimationen.

Änderungen erscheinen sofort als Vorschau. **Einstellungen speichern** behält sie lokal; **Verwerfen** oder das Verlassen der Seite stellt die gespeicherte Auswahl wieder her. Finanzdaten und Excel-Schema werden dadurch nicht geändert.

## Prüfungen

`npm test`, `npm run typecheck`, `npm run lint` und `npm run test:e2e` prüfen Parser, Berechnung, Excel-Roundtrips und Browserabläufe. Anonymisierte Layout-Fixtures liegen unter `src/lib/import/fixtures`. Zusätzliche Tests lesen die privaten Originale aus `import-example`, falls dieser Ordner vorhanden ist.

Für die Browserabnahme des Produktionsstands zuerst `npm run build` ausführen und anschließend `PLAYWRIGHT_PRODUCTION=1` für `npm run test:e2e` setzen (PowerShell: `$env:PLAYWRIGHT_PRODUCTION = "1"`). Playwright startet und beendet dafür einen eigenen Produktionsserver auf Port 3100, ohne einen laufenden Entwicklungsserver wiederzuverwenden. Danach die Variable wieder entfernen (PowerShell: `Remove-Item Env:PLAYWRIGHT_PRODUCTION`).
