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
- Das Prüfsymbol links neben der Umsatzsuche und die Navigation zählen jede offene Buchung: fehlende Kategorie, Prüfen, ungelöster POS-Text, unbekannter Händler, Regelkonflikt oder unklare Mittagszeit. Beide zeigen eine kreisrunde Blase in der gewählten Akzentfarbe; bei null verschwindet sie. **Dateien auswählen** bleibt rechts im Mehrdatei-Dropbereich. Excel-Sicherung und Wiederherstellung gibt es ausschließlich unter **Einstellungen → Sicherung**; ungültige Excel-Umsatzzeilen werden still übersprungen.
- POS-/Terminaltexte werden aus Verwendungszweck, Details oder zusätzlichen Textfeldern zum echten Händler ergänzt, auch beim gemeinsamen CSV-/PDF-Import. Originaltext und Zusatzfelder bleiben gespeichert und in Excel-Sicherungen erhalten. Vorhandene POS-Zeilen werden daraus oder beim erneuten Ablegen desselben Auszugs nachgepflegt, ohne Betrag, Datum oder ID zu ändern. Mehrdeutige Treffer bleiben offen. Gelernte Händlerkategorien gelten auch für spätere Imports; Martin-Auer-Filialen teilen sich einen stabilen Händlerschlüssel.
- **Gehalt und monatliche Rufbereitschaft** werden automatisch unterschieden und ohne Dauerbetragsfrage gespeichert. Dafür zählen auch Abrechnungsmonat und Zusatzfelder: Die separate TeamTalentSolutions-Zahlung für eine frühere Abrechnung in der ersten Monatshälfte ist Rufbereitschaft, auch über 500 €. Alte Gehaltsrückfragen werden beim Laden nachgepflegt; Originalbeträge und Buchungen bleiben erhalten. Schwankungen und Sonderzahlungsmonate **März, Juli und Dezember** überschreiben weder Grundgehalt noch geplante Monatswerte dauerhaft.
- Leasing, Vollkasko, Haftpflicht, Handyvertrag und Apple Care werden mit dem Monatsraster abgeglichen, nicht doppelt gebucht. Abweichungen über 0,05 € benötigen **Ja/Nein**. Ja übernimmt den Betrag ab dem Buchungsmonat bis Ende 2027; Nein behält die Monatswerte. Entscheidungen bleiben auch in Excel-Sicherungen erhalten.
- Reguläres **Gehalt am 26.–30.** gehört zum Folgemonat, auch im Monatsfilter und in der Umsatzsumme. Für das bekannte TeamTalentSolutions-Abrechnungsmuster gilt vor März, Juli und Dezember bereits der 25. (beispielsweise 25. Februar → März). Rufbereitschaft und ausdrücklich separat bezeichnete Sonderzahlungen bleiben im Buchungsmonat. Interne Transfers zählen nur bei aktiviertem Transferfilter zur Umsatzsumme.
- PDF-Text wird lokal im Browser extrahiert; keine Kontoauszüge werden hochgeladen. Versetzte Beträge und CR-Gutschriften werden unterstützt. Unklare Textzeilen kommen in die Prüfliste. Für reine Scans ist keine OCR enthalten.

## Automatische Planung

Beim Laden und nach jedem erfolgreichen Import werden Stichtag, variabler Plan und Pocket-Verteilung aktualisiert. Die vier abgeschlossenen Monate verschieben sich automatisch; auch ein geöffneter Tab erkennt den Tageswechsel. Nach Fixkosten und Alltagsbudget gehen zuerst bis zu **180 € ins Sparkonto**, danach Beträge bis zur Zielhöhe an die **Sparziele nach Termin**, zuletzt der Rest an **Urlaub**. Bei weniger Überschuss bleibt die gesamte verfügbare Summe im Sparkonto; alte Prozent- und Motorradraten überschreiben den Sockel nicht.

Unter **Einstellungen → Sparziele** lassen sich Ziele hinzufügen, bearbeiten und entfernen. Entfernen löscht keine Buchungen. Erreichte Ziele erhalten ab dem Folgemonat keine weitere Rate, auch nach einer Entnahme. Ohne offene Ziele geht der Rest nach dem Sockel an Urlaub. Die Übersicht zeigt nur positive Monatsraten. Häkchen prüfen eingehende Transfers des aktuellen Monats bis zum Stichtag; die Toleranz beträgt **5 € oder 3 %**, je nachdem, was größer ist. Bei 180 € gehören **174,60 € und 185,40 €** noch dazu. Kontostände allein setzen kein Häkchen.

Lebensmittel, Mittagessen, Tanken, G2A und Ausgehen werden ab dem aktuellen Monat automatisch berechnet. Manuelle Einzelwerte im Monatsraster sind explizite Overrides; ein leeres Feld aktiviert wieder „Auto“. Gesamtbudget-Overrides bleiben ebenfalls erhalten. Der unterstützte Planungshorizont bleibt 2026–2027.

**BIPA, Hotspot und Mensa sind immer Mittagessen**, unabhängig von Großschreibung, Datum, Uhrzeit oder alten Händlerentscheidungen. Andere Mittagshändler bleiben an Werktage außerhalb der österreichischen Feiertage einschließlich 10. Oktober in Kärnten und **11:00–14:00 Uhr einschließlich** gebunden. Ohne belegte Uhrzeit bleibt eine mögliche Mittagszuordnung offen. AMEX-Kartenabrechnungen auf Giro/Revolut sind Umbuchungen, keine zweite Ausgabe; die eigentlichen Käufe und Mitgliedsgebühren bleiben Ausgaben.

**Gemeinsamer Urlaub:** Airlines und Buchungsplattformen wie Swiss, Ryanair, easyJet, Booking.com und Airbnb zählen mit **50 % Eigenanteil** unter Urlaub; die andere Hälfte bleibt als Forderung sichtbar. Ein späterer Eingang mit dem bestätigten Partnernamen und höchstens **5 € Abweichung** gleicht genau eine passende offene Hälfte aus. Es gibt keine starre Zwei-Wochen-Frist. Bei mehreren Treffern gilt zuerst der passendste Betrag, dann die älteste offene Buchung. Der Eingang ist kein Planeinkommen und verändert den Eigenanteil nicht. Bankbeträge bleiben unverändert; Rückzahlungen werden nach Neuladen, Importen und Löschungen neu zugeordnet. Gewöhnliche Einkäufe und Mittagessen werden nicht geteilt.

**Einstellungen → Trade Republic** speichert Kontostand und jährlichen Zinssatz mit Datum. Die Zinsprognose berücksichtigt fest **27,5 % KESt**, unabhängig von alten Sicherungsfeldern.

## Erscheinungsbild

Unter **Einstellungen → Erscheinungsbild** stehen sechs Akzentfarben, ein Farbwähler und reduzierte Bewegung bereit. Die persönliche Farbe gilt für Logo, Navigation, Buttons, Diagrammakzent und Fokusmarkierungen – auch unter saisonalen Themes. Text und Buttons erhalten bei Bedarf kontrastgerechte Farben.

Die Saison folgt dem lokalen Kalender: Fasching, Ostern, Sommer, Halloween, Weihnachten, Zwischen den Jahren und Neujahr. Die aufklappbare **Saisonvorschau** zeigt alle Varianten einschließlich Default, ohne diese Auswahl zu speichern. Saisonale Details ergänzen nur eine leichte Tönung von Header/Sidebar, wenige statische Icons und ein Detail am ursprünglichen Finanzblick-Logo. Tabellen bleiben neutral; es gibt keine Szenen, Overlays oder Partikelanimationen.

Änderungen an Akzentfarbe und Bewegung erscheinen sofort als Vorschau. **Einstellungen speichern** behält sie lokal; **Verwerfen** oder das Verlassen der Seite stellt die gespeicherte Auswahl wieder her. Sparziele, Auszugsuhrzeiten und Erscheinungsbild bleiben auch in Excel-Sicherungen erhalten.

## Prüfungen

`npm test`, `npm run typecheck`, `npm run lint` und `npm run test:e2e` prüfen Parser, Berechnung, Excel-Roundtrips und Browserabläufe. Anonymisierte Layout-Fixtures liegen unter `src/lib/import/fixtures`. Zusätzliche Tests lesen die privaten Originale aus `import-example`, falls dieser Ordner vorhanden ist.

Für die Browserabnahme des Produktionsstands zuerst `npm run build` ausführen und anschließend `PLAYWRIGHT_PRODUCTION=1` für `npm run test:e2e` setzen (PowerShell: `$env:PLAYWRIGHT_PRODUCTION = "1"`). Playwright startet und beendet dafür einen eigenen Produktionsserver auf Port 3100, ohne einen laufenden Entwicklungsserver wiederzuverwenden. Danach die Variable wieder entfernen (PowerShell: `Remove-Item Env:PLAYWRIGHT_PRODUCTION`).
