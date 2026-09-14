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
- Originaldatum, Text, Betrag und Konto bleiben unverändert. Kategorie auswählen und **Zuordnung übernehmen** oder **Später prüfen**. Offene Einträge bleiben auch nach dem Neuladen erreichbar. **Zuordnung prüfen** nimmt unklare bereits gespeicherte Umsätze in die Prüfliste auf; gleiche Händler werden gemeinsam zugeordnet, ohne neue Buchungen anzulegen.
- Gehalt, Leasing, Vollkasko, Haftpflicht und Handyvertrag werden mit dem Monatsraster abgeglichen, nicht doppelt gebucht. Abweichungen über 0,05 € benötigen **Ja/Nein**. Ja übernimmt den Betrag ab dem Buchungsmonat bis Ende 2027; Nein behält die Monatswerte. Entscheidungen bleiben auch in Excel-Sicherungen erhalten.
- PDF-Text wird lokal im Browser extrahiert; keine Kontoauszüge werden hochgeladen. Versetzte Beträge und CR-Gutschriften werden unterstützt. Unklare Textzeilen kommen in die Prüfliste. Für reine Scans ist keine OCR enthalten.

## Automatische Planung

Beim Laden und nach jedem erfolgreichen Import werden Stichtag, variabler Plan und Pocket-Verteilung aktualisiert. Die vier abgeschlossenen Monate verschieben sich automatisch; auch ein geöffneter Tab erkennt den Tageswechsel. Nach Fixkosten und Alltagsbudget gehen zuerst bis zu **180 € ins Sparkonto**, danach Beträge bis zur Zielhöhe an die **Sparziele nach Termin**, zuletzt der Rest an **Urlaub**. Bei weniger Überschuss bleibt die gesamte verfügbare Summe im Sparkonto; alte Prozent- und Motorradraten überschreiben den Sockel nicht.

Unter **Einstellungen → Sparziele** lassen sich Ziele hinzufügen, bearbeiten und entfernen. Entfernen löscht keine Buchungen. Erreichte Ziele erhalten ab dem Folgemonat keine weitere Rate, auch nach einer Entnahme. Ohne offene Ziele geht der Rest nach dem Sockel an Urlaub. Die Übersicht zeigt nur positive Monatsraten. Häkchen prüfen eingehende Transfers des aktuellen Monats bis zum Stichtag; die Toleranz beträgt **5 € oder 3 %**, je nachdem, was größer ist. Bei 180 € gehören **174,60 € und 185,40 €** noch dazu. Kontostände allein setzen kein Häkchen.

Lebensmittel, Mittagessen, Tanken, G2A und Ausgehen werden ab dem aktuellen Monat automatisch berechnet. Manuelle Einzelwerte im Monatsraster sind explizite Overrides; ein leeres Feld aktiviert wieder „Auto“. Gesamtbudget-Overrides bleiben ebenfalls erhalten. Der unterstützte Planungshorizont bleibt 2026–2027.

**Mittagessen** setzt einen Werktag außerhalb der österreichischen Feiertage einschließlich 10. Oktober in Kärnten und eine belegte Uhrzeit zwischen **11:00 und 14:00 Uhr einschließlich** voraus. Auszüge ohne Uhrzeit erhalten keine erfundene Mittagszeit. AMEX-Kartenabrechnungen auf Giro/Revolut sind Umbuchungen, keine zweite Ausgabe; die eigentlichen Käufe und Mitgliedsgebühren bleiben Ausgaben.

**Einstellungen → Trade Republic** speichert Kontostand und jährlichen Zinssatz mit Datum. Die Zinsprognose berücksichtigt fest **27,5 % KESt**, unabhängig von alten Sicherungsfeldern.

## Erscheinungsbild

Unter **Einstellungen → Erscheinungsbild** stehen sechs Akzentfarben, ein Farbwähler und reduzierte Bewegung bereit. Die persönliche Farbe gilt für Logo, Navigation, Buttons, Diagrammakzent und Fokusmarkierungen – auch unter saisonalen Themes. Text und Buttons erhalten bei Bedarf kontrastgerechte Farben.

Die Saison folgt dem lokalen Kalender: Fasching, Ostern, Sommer, Halloween, Weihnachten, Zwischen den Jahren und Neujahr. Die aufklappbare **Saisonvorschau** zeigt alle Varianten einschließlich Default, ohne diese Auswahl zu speichern. Saisonale Details ergänzen nur eine leichte Tönung von Header/Sidebar, wenige statische Icons und ein Detail am ursprünglichen Finanzblick-Logo. Tabellen bleiben neutral; es gibt keine Szenen, Overlays oder Partikelanimationen.

Änderungen an Akzentfarbe und Bewegung erscheinen sofort als Vorschau. **Einstellungen speichern** behält sie lokal; **Verwerfen** oder das Verlassen der Seite stellt die gespeicherte Auswahl wieder her. Sparziele, Auszugsuhrzeiten und Erscheinungsbild bleiben auch in Excel-Sicherungen erhalten.

## Prüfungen

`npm test`, `npm run typecheck`, `npm run lint` und `npm run test:e2e` prüfen Parser, Berechnung, Excel-Roundtrips und Browserabläufe. Anonymisierte Layout-Fixtures liegen unter `src/lib/import/fixtures`. Zusätzliche Tests lesen die privaten Originale aus `import-example`, falls dieser Ordner vorhanden ist.

Für die Browserabnahme des Produktionsstands zuerst `npm run build` ausführen und anschließend `PLAYWRIGHT_PRODUCTION=1` für `npm run test:e2e` setzen (PowerShell: `$env:PLAYWRIGHT_PRODUCTION = "1"`). Playwright startet und beendet dafür einen eigenen Produktionsserver auf Port 3100, ohne einen laufenden Entwicklungsserver wiederzuverwenden. Danach die Variable wieder entfernen (PowerShell: `Remove-Item Env:PLAYWRIGHT_PRODUCTION`).
