# Logo-Testlauf auf echten Händlern

`npm run eval:logos` misst, wie viele Händler aus den **echten** Buchungen des Haushalts in Finanzblick ein Logo zeigen, woher es kommt und ob es stimmt.

- **Grundlage:** die lokale Datenbank (`.local-data/finanzblick.sqlite` oder `FINANZBLICK_DATABASE_PATH`), ihre Logo-Speicher und der Logo-Ordner (`Logo/` oder `FINANZBLICK_LOGO_DIR`).
- **Nur eine Kopie:** Jeder Lauf zieht zuerst eine frische Kopie aller drei nach `.local-data/logo-eval/snapshot/` (SQLite `VACUUM INTO`) und arbeitet nur darauf. Die App-Daten und der echte Logo-Ordner bleiben unverändert, außer mit `--apply`.
- **Privat:** Händlernamen, Buchungstexte und Logos erscheinen ausschließlich in Berichten unter `.local-data/logo-eval/`. Der Ordner ist per `.gitignore` ausgeschlossen. In dieses Dokument kommen nur Summen und allgemein bekannte Marken.

## Ablauf

1. **Wie die App** (`evaluateLogos` in `src/lib/ai/logo-eval.ts`)
   - Jede Buchung, die in der Umsatzliste ein Händlerzeichen zeigt (`shouldShowMerchantMark`), wird genau so aufgelöst wie in `MerchantMark`: Bankomat, privates Buchungslogo, Katalog-Händler, Händlername, Buchungstext.
   - Die Auflösung `bookingLogoMarks` in `src/lib/ai/logo-sweep.ts` ist dieselbe, die auch die Hintergrundsuche nutzt. Testlauf, Suche und Anzeige können also nicht auseinanderlaufen.
2. **Je Händler gruppiert:** mit demselben Schlüssel, unter dem die Hintergrundsuche einen Händler einmal sucht. Alle Spar-Filialen sind „Spar“, aber „Farmacia Norte“ und „Farmacia Sur“ sind zwei Händler.
3. **Art:** Händler, Bankomat (zeigt das Logo seiner Bank) oder Person. Bei Überweisungen von und an Personen („Auftraggeber: Max Muster“) sind Initialen richtig; sie zählen nicht zur Händler-Abdeckung.
4. **Herkunft:** Logo-Ordner (Datei mit Dateiname), freigegebene Wikimedia-Datei oder öffentlicher Katalog.
5. **Prüfung:**
   - Automatisch: leeres Bild (auch weißes Logo auf weißem Grund), dasselbe Bild für zwei verschiedene Marken, Branchenwort oder Ortsname als Dateiname.
   - Per Auge: `--sheet` schreibt Kontaktbögen mit Logo und Händlername. Bewertungen (`--ok`, `--wrong`, `--generic`) stehen in `verdicts.json`. Sie gelten nur für genau diese Logo-Version; ändert sich das Bild, ist der Händler wieder „ungeprüft“.
6. **Suche** (`--search`): Die Hintergrundsuche der App (`sweepMissingLogos`) läuft auf der Kopie.
   - Sie startet ohne Gedächtnis, also bekommt jeder Händler ohne Logo genau einen Versuch.
   - Antworten werden in `http-cache/` 14 Tage gespeichert, unerreichbare Hosts 3 Tage. Drosselungen und Fehlerantworten werden nie gespeichert. Wiederholte Läufe sind so schnell und belasten die Dienste nicht.
   - Höflich: Wikidata höchstens alle 1,5 s, Nominatim alle 1,1 s, Wikimedia jede Sekunde, andere Hosts alle 0,5 s. Bei Drosselung wartet der Lauf genau so lange, wie der Dienst verlangt (höchstens 20 Minuten insgesamt), und nennt Host und Grund.
   - `--model` erlaubt der Suche die lokale KI für mehrdeutige Namen, wie in der App.
7. **Vergleich:** Liegt `baseline.json` vor, vergleicht der Lauf jeden Händler damit: neu mit Logo, Logo verloren, anderes Bild, Status schlechter oder besser. `--fail-on-regression` beendet den Lauf mit Exit 1, wenn ein Logo verloren geht oder schlechter wird.

## Kennzahlen

| Kennzahl | Bedeutung |
|---|---|
| Abdeckung | Händler mit Logo / Händler |
| richtig (geprüft) | Logo per Sichtprüfung bestätigt |
| ohne Befund | mit Logo und weder als falsch noch als generisch erkannt (geprüft oder ungeprüft) |
| Buchungen mit Logo | Anteil der Buchungen mit Händlerzeichen, die ein Logo zeigen |

## Benutzung

```powershell
npm run eval:logos                              # Abdeckung messen, ohne Netz
npm run eval:logos -- --sheet                   # dazu Kontaktbögen der angezeigten Logos
npm run eval:logos -- --merchant "spar"         # einen Händler erklären: Logo, Herkunft, Suchnamen, ungenutzte Dateien, Buchungen
npm run eval:logos -- --search --sheet          # fehlende Logos suchen wie die App; Kontaktbogen nur der neuen
npm run eval:logos -- --search --model          # mit lokaler KI für mehrdeutige Namen (npm run ai:server)
npm run eval:logos -- --search --merchant "x"   # nur diesen Händler suchen
npm run eval:logos -- --ok <schlüssel> --wrong <schlüssel> --generic <schlüssel> [--note "…"]
npm run eval:logos -- --save-baseline           # diesen Lauf als Vergleichsbasis merken
npm run eval:logos -- --search --apply          # gefundene Logos in den echten Logo-Ordner kopieren
```

- Jeder Lauf schreibt `report-<Zeit>.json` (alle Händler mit Logo, Herkunft, Befunden, Suchnamen und Beispielbuchungen, dazu jede Suche mit Ergebnis und Quelle) und `report-<Zeit>.md`. Die Markdown-Datei enthält die Tabelle, die Herkunft, den Vergleich, die Suchergebnisse, fehlende und zweifelhafte Logos.
- „Passende Dateien, die nicht angezeigt werden“ nennt Dateien im Logo-Ordner, deren Name in den Buchungen steht, die aber keine davon zeigt. Das deckt Zuordnungsfehler auf.
- Ohne Datenbank meldet das Skript „nichts zu bewerten“ und endet erfolgreich. Die Mechanik prüfen `src/lib/ai/logo-eval.test.ts`, `logo-sweep.test.ts`, `logo-finder.test.ts`, `logo-import.test.ts` und `src/lib/automation/merchant-local-logos.test.ts` mit synthetischen Daten in `npm test`.
- Laufzeit ohne Netz: etwa 10 s. Eine erste Suche dauert wegen der Wartezeiten bei Wikidata 20–30 Minuten, mit Cache wenige Minuten.

## Ergebnis November 2026

Datenstand: 1.226 Buchungen mit Händlerzeichen bei 334 Händlern, dazu 55 Bargeldbehebungen an 13 Bankomaten und 3 Personen. Alle Logos, die die App am Ende zeigt, sind per Sichtprüfung bewertet.

| | Start | nach den Zuordnungs-Fixes | nach Suche und Bereinigung |
|---|---:|---:|---:|
| Händler mit Logo | 129 (38,6 %) | 144 (43,1 %) | **178 (53,3 %)** |
| davon richtig (geprüft) | 123 (36,8 %) | 123, dazu 13 ungeprüft | **173 (51,8 %)** |
| falsch | 0 sichtbar¹ | 3 der 13 ungeprüften¹ | **0** |
| generisch | 6 | 8 | 5² |
| ohne Logo | 205 | 190 | 156 |
| Buchungen mit Logo | 864 (70,5 %) | 917 (74,8 %) | **987 (80,5 %)** |

¹ Drei falsche Dateien lagen schon im Logo-Ordner (eine fremde Firma, eine andere Apotheke, eine Arena gleichen Namens), wurden aber wegen der Zuordnungsfehler nicht angezeigt. Nach den Fixes wurden sie sichtbar. Die Sichtprüfung fand sie; sie liegen jetzt gesichert unter `.local-data/logo-eval/entfernt/`, ebenso ein Tourismus-Logo, das für eine Ortsangabe stand.
² Eigene Dateien mit Foto statt Logo oder einem allgemeinen Symbol (Taxi-Schild, Kochmütze). Sie bleiben, bis sie ersetzt werden.

- **Keine Verschlechterung:** Gegenüber dem Start hat kein Händler ein richtiges Logo verloren oder ein anderes Bild bekommen. Weggefallen ist nur das Tourismus-Logo.
- **Suche:** 150 Händler ohne Logo wurden einmal gesucht, 39 Logos gefunden, davon 18 von Wikimedia Commons und 21 von der Webseite des Händlers. Ohne lokale KI sind es 4 weniger.
- **Bankomaten:** Die 2 österreichischen Automaten zeigen das Raiffeisen-Logo. Die 11 Bargeldbehebungen im Ausland haben keinen bekannten Betreiber und bekommen bewusst kein geratenes Logo.

### Gefundene Fehlerquellen und Änderungen

1. **Vorhandene Dateien wurden nicht angezeigt** (15 Händler, 46 Buchungen). Die Datei lag im Ordner, nur die Zuordnung zum Buchungstext scheiterte (`merchant-booking-presentations.ts`):
   - Ein unscharfer Fast-Treffer im öffentlichen Katalog, ohne konkreten Händler, blockierte die Datei („SWISS Intl Air Lines“, „EUROPA PARK SHOPPING“).
   - Zwei Dateien derselben Marke („OBI“, „OBI SAGT DANKE“) oder eine Ortsdatei neben der Marke („Dunkin“ und „Wien“) galten als Widerspruch.
   - Revolut-Richtungswörter („To …“), ein Katalogwort im eigenen Dateinamen („Cafe“ in „Lift Cafe“), ausgeschriebene Umlaute („OEBB“), Terminalnummern im Dateinamen und Initialen („HM“ für „H&M“) verhinderten den Treffer.
   - → Die Datei, mit der der Text beginnt, gewinnt, unter diesen die längste. Ein Katalogtreffer blockiert nur noch, wenn er wirklich konkurriert. Umlaut-, Nummern- und Initialen-Varianten passen. Ein Händlername, der eine Webadresse ist („OEBB.AT“), zeigt seine Marke; längere Firmennamen bleiben eigene Identitäten.
2. **Ein Händler mit toter Webseite hielt die ganze Suche an.** Lud die offizielle Webseite aus Wikidata nicht, galt das als vorübergehend. Die Suche stoppte, und beim nächsten Mal stand derselbe Händler wieder vorn. Dasselbe galt für Wikidatas „too busy“ in einer normalen Antwort.
   - → Eine Händlerseite, die nicht lädt, ist keine Pause mehr. Überlastungsmeldungen von Wikidata pausieren den Dienst 2 Minuten.
3. **Die Suche versuchte es nie wieder.** Nicht gefundene Händler blieben 30 Tage gesperrt, auch nach Verbesserungen der Suche.
   - → Das Gedächtnis kennt die Version der Suche. Eine neue Version versucht jeden Händler einmal neu. Fälle, die nur am fehlenden lokalen Modell scheitern, kommen nach 3 Tagen wieder dran.
4. **Viele Händler wurden gar nicht gesucht:**
   - Revolut-Kartenzahlungen ohne Ort („dm drogerie“, „BP“).
   - Namen, deren letztes Wort als Ort galt („Pizzeria Nordlicht“ wurde zu „Pizzeria“ in „Nordlicht“).
   - Firmen-Empfänger über PayPal ohne geratene Webseite („… GmbH“).
   - Domains im Buchungstext („BEISPIEL.GG“) wurden nicht genutzt.
   - → Alle diese Fälle werden jetzt gesucht. Personen und reine Branchenwörter dagegen bewusst nicht mehr: „Farmacia“, „Backerei“ und „E Center“ sind keine Marke, „Auftraggeber: Max Muster“ ist eine Person.
5. **Falsche Treffer verhindert:**
   - Ortsnamen: Wikidata-Einträge für Orte, Personen, Werke, Bezirke und Schulen zählen nie, und für solche Namen wird keine Domain geraten.
   - Die lokale KI darf nur zwischen Marken mit eigenem Commons-Logo wählen. Sie hatte für kurze Namen eine Pistole, einen Londoner Bezirk, ein Gymnasium und einen Fernsehsender gewählt.
   - Icons: Domain-Parkplätze, Icons, die zu sozialen Netzwerken umleiten, Agentur-Logos aus dem Seitenfuß und weiße Logos, die auf dem hellen Hintergrund unsichtbar wären, werden verworfen.
   - Eine gleichnamige Firma unter einer anderen Endung wird nicht genommen, wenn die eigene Seite schon gefunden ist.
   - Ohne Antwort von Wikidata wird nichts geraten.
6. **Große Marken blockieren Bots** (Subway, Etsy, Eurowings, Epic Games, BP …).
   - → Die kuratierte Liste `src/lib/ai/logo-brands.ts` nennt neben der Webseite die Wikidata-ID. Das Logo kommt dann von Commons. Die IDs sind über die Wikidata-API geprüft.
7. **Neue Quellen auf Webseiten:** App-Icons aus dem Web-App-Manifest und das Organisations-Logo aus JSON-LD.
8. **Gelöschte Dateien blieben sichtbar,** weil der Live-Sync nur hinzufügte.
   - → Eine aus dem Ordner entfernte Datei nimmt ihr Logo zurück (nur bei vollständiger Ordnerliste und nur für Dateien dieses Ordners). Kehrt die Datei zurück, gilt sie wieder.
9. **Bargeldbehebungen im Ausland** („Bargeldbehebung Flughafen“, „ATM …“) galten als Händler, und ihr Ortsname wurde gesucht.
   - → Sie sind jetzt Bankomaten, aber ohne geratenes Bank-Logo.
10. **Import:** Die Suche lief nur einmal pro Seitenaufruf im Browser.
    - → Sie läuft jetzt nach jedem Import erneut und zusätzlich im Hintergrund-Worker nach jedem Kontoauszug, ohne den Import aufzuhalten.

Jede Änderung hat Unit-Tests in `logo-finder.test.ts`, `logo-sweep.test.ts`, `logo-import.test.ts`, `logo-eval.test.ts`, `merchant-local-logos.test.ts`, `merchant-live-logo-directory.test.ts` und `atm-logo.test.ts`.

### Warum nicht 98 %

Von den 156 Händlern ohne Logo kommen 125 nur mit einer einzigen Buchung vor:

| Grund | Händler | Buchungen |
|---|---:|---:|
| Keine Quelle kennt das Geschäft: kleine Lokale, Läden und Unterkünfte, viele aus Urlauben im Ausland | 108 | 165 |
| Kein Markenname im Text: nur Branchenwort, eigene Notiz oder Sammelbegriff („TANKSTELLE 1234“) | 36 | 50 |
| Webseite verweigert automatische Zugriffe | 6 | 12 |
| Anonyme Zahlung über einen Zahlungsdienst | 5 | 10 |

Für diese Geschäfte gibt es keinen Wikidata-Eintrag und keine eingetragene Webseite in OpenStreetMap. Ihr Name ergibt auch keine eindeutige Domain. Ihre Webseite fände nur eine allgemeine Websuche. Die würde aber Händlernamen und Orte aus den eigenen Buchungen an eine Suchmaschine schicken. Deshalb ist sie nicht eingebaut.

Für die übrigen Geschäfte gibt es zwei Wege:
- **Eigene Datei:** das Logo als Datei mit dem Händlernamen in `Logo/` ablegen. Der Testlauf nennt die Namen in „Ohne Logo“.
- **Override:** die Webseite oder den Wikidata-Eintrag in `Logo/.logo-overrides.json` eintragen, dann holt die Suche das Logo selbst (siehe [Händler-Logos](local-ai.md#händler-logos)).

Ohne Logo zeigt die App weiter die Initialen des Händlers, wie im Design vorgesehen.
