# Kategorisierungs-Testlauf auf echten Buchungen

`npm run eval:categories` misst, wie genau Finanzblick die **echten** Buchungen des Haushalts kategorisiert. Dafür spielt es jeden Monat so nach, als käme der Kontoauszug gerade erst an. Grundlage ist die lokale Datenbank (`.local-data/finanzblick.sqlite` oder `FINANZBLICK_DATABASE_PATH`), die nur gelesen wird. Echte Buchungen, Händlernamen und Beträge erscheinen ausschließlich in Berichten unter `.local-data/categorization-eval/`. Dieser Ordner ist per `.gitignore` ausgeschlossen. In dieses Dokument und ins Repository kommen nur Summen.

## Ablauf

1. **Monatsweise nachspielen** (`simulateMonth` in `src/lib/ai/categorization-eval.ts`)
   - Bekannt ist nur das Ledger *vor* dem jeweiligen Monat: Buchungen, Fixkosten-Belege, Namensregeln, Urlaubszeiträume, Web-Branchen.
   - Eine Händlerregel des Nutzers existiert erst, sobald er vorher eine Buchung mit diesem Schlüssel selbst kategorisiert oder benannt hat. Eine später gelernte und rückwirkend verteilte Regel sickert so nicht in die Vergangenheit.
   - Die Buchungen des Monats werden auf das reduziert, was ein Kontoauszug liefert (`importSource`): Datum, Text, Rohdetails, Bank-Kategorie, Betrag. Kategorie, Händlername, Regeln und Prüfflags fallen weg.
   - Danach läuft exakt der Weg des Hintergrund-Workers: `enrichTransaction` → `prepareStatementImport` → `commitStatementImport` → `queueLedgerReview` → `assignAfterImport` (Regeln, Historie, Erstattungen, Bank-Paare, Branche – ohne Modell).
   - Gelesen wird das Ergebnis über `actualBookings`, also so, wie die App es anzeigt: inklusive Fixkosten-Belegen und geteilter Urlaube.
2. **Optional mit Modell** (`--model`): Alles, was danach noch offen ist, geht wie in der App in Achterpaketen an das lokale Modell (`categorizeBookings`). Eine Antwort zählt nur, wenn das Beleg-Gate (`decideReviewWithEvidence`) sie bestätigt. Der Bericht hält zusätzlich die rohe Modellantwort fest. So sieht man, ob das Gate zu streng oder zu locker ist. Voraussetzung ist ein laufender Modellserver (`npm run ai:server`).
3. **Wahrheit** (`evaluationLabels`): Jede Buchung erhält die Kategorie, die die App heute anzeigt, und eine Herkunft:
   - `confirmed`: vom Nutzer selbst gewählt (Stift, Prüfdialog, Assistent).
   - `rule`: Ergebnis einer aktiven Händlerregel des Nutzers.
   - `ai`: früher von der KI-Prüfung entschieden. Diese Entscheidungen sehen in den Daten wie Klicks aus, zählen hier aber nicht als sicher.
   - `accepted`: automatisch vergeben und nie beanstandet.

   Sichere Labels sind `confirmed` und `rule`. Offene Prüfungen, ignorierte Buchungen und Käufe, die eine fehlerhafte Transfer-Regel umgebogen hat (siehe unten), bleiben ohne Wahrheit.
4. **Eingefroren:** Die Wahrheit wird je Datenstand (Revision der Finanzdaten) in `ground-truth.json` gespeichert. Geänderter Code kann so seine eigenen Labels nicht verschieben, und Vorher/Nachher bleiben vergleichbar. Ändern sich die Daten, wird sie neu abgeleitet; `--refresh-labels` erzwingt das.
5. **Urlaubszeiträume** werden getrennt bewertet. Dort zeigt die App unbekannte Ausgaben als Urlaub. Ob ein Geschäft als „daheim“ gilt, hängt aber von späteren Besuchen ab, also von Wissen, das es beim Import noch nicht gab.

## Kennzahlen

| Kennzahl | Bedeutung |
|---|---|
| Präzision | richtige / automatisch entschiedene Buchungen: Wie oft stimmt eine stille Zuordnung? |
| Abdeckung | automatisch entschiedene / bewertete Buchungen: Wie viel bleibt nicht in der Prüfliste? |
| Genauigkeit | richtige / bewertete Buchungen: Eine offene Prüfung zählt hier als „nicht richtig“. |

Präzision hat Vorrang: Eine falsche stille Zuordnung verfälscht Budget und Auswertung. Eine offene Prüfung kostet nur einen Klick.

## Benutzung

```powershell
npm run eval:categories                          # alle Monate, Bericht nach .local-data/categorization-eval/
npm run eval:categories -- --months 2026-09,2026-10
npm run eval:categories -- --model               # zusätzlich KI-Prüfung mit dem lokalen Modell
npm run eval:categories -- --save-baseline       # aktuellen Lauf als Vergleichsbasis merken
npm run eval:categories -- --fail-on-regression  # Exit 1, wenn eine vorher richtige Buchung jetzt falsch ist
npm run eval:categories -- --booking <id>        # eine Buchung erklären: Quelle, Wahrheit, Anreicherung, Prüfgrund, Belege
npm run eval:categories -- --set <id>=Freizeit   # Wahrheit für eine Buchung korrigieren (labels.json)
npm run eval:categories -- --exclude <id>        # Buchung aus der Bewertung nehmen
```

- Jeder Lauf schreibt `report-<Zeit>.json` (alle Datensätze, falsche und offene Buchungen mit Text und Betrag) und `report-<Zeit>.md` (Tabellen nach Herkunft, Methode, Bank, Vorzeichen, Monat, Kategorie, Verwechslungen, gruppierte Händler).
- Liegt `baseline.json` vor, vergleicht der Lauf jede Buchung damit: verbessert, verschlechtert, jetzt offen, neu falsch.
- Ohne Datenbank meldet das Skript „nichts zu bewerten“ und endet erfolgreich. CI braucht deshalb keine privaten Daten.
- `src/lib/ai/categorization-eval.test.ts` prüft die Mechanik mit synthetischen Buchungen in `npm test`: Quellreduktion, Herkunft der Labels, Regel-Zeitpunkt, Monatsnachspiel, Modell-Gate, Vergleich.
- Laufzeit ohne Modell: etwa 25 s für rund 3.400 Buchungen.

## Ergebnis November 2026

Datenstand: 3.414 echte Buchungen (Januar bis November 2026; Revolut, Raiffeisen, Amex, Trade Republic). Bewertet werden 2.854 Buchungen mit Wahrheit außerhalb von Urlaubszeiträumen, davon 431 mit sicherem Label. Beide Spalten nutzen dieselbe eingefrorene Wahrheit und denselben Testlauf. „Vorher“ ist der Stand `6c082e1`, nachgespielt in einem eigenen Arbeitsbaum.

### Regeln, Historie und Belege (ohne Modell)

| Labels | Buchungen | Präzision vorher | Präzision nachher | falsch vorher → nachher | offen vorher → nachher |
|---|---:|---:|---:|---:|---:|
| sicher (Hand + Regel) | 431 | 79,4 % | **88,3 %** | 51 → **29** | 176 → 175 |
| davon selbst gewählt | 264 | 77,3 % | **95,0 %** | 27 → **6** | 145 → 144 |
| davon Händlerregel | 167 | 81,3 % | 82,0 % | 24 → 23 | 31 → 31 |
| frühere KI-Entscheidung | 106 | 89,5 % | 95,6 % | 10 → 4 | 11 → 15 |
| automatisch, nie beanstandet | 2.317 | 99,7 % | 99,9 % | 7 → 3 | 38 → **11** |
| alle | 2.854 | 97,4 % | **98,6 %** | 68 → **36** | 225 → **201** |
| Urlaubszeiträume (separat) | 465 | 97,7 % | 97,7 % | 10 → 10 | 19 → 19 |

Abdeckung aller Labels: 92,0 % → 92,9 %. Je Buchung verglichen: **58 verbessert, keine vorher richtige Buchung jetzt offen, keine vorher offene jetzt falsch.** Zwei Buchungen wechseln von einem früheren KI-Label (Trafik = Shopping) zur Kategorie, die der Haushalt bei allen anderen Trafiken selbst gewählt hat (Freizeit). Beide sind schwache Labels, daher keine echte Verschlechterung.

Nach Stufe: Die automatische Belegprüfung (`review-auto`) stieg von 75,2 % auf 88,7 % Präzision (38 → 14 Fehler). Händlerkatalog, gelernte Regeln, Historie und Umbuchungen liegen jetzt bei 100 %. Nach Bank: Revolut 98,8 % → 100 %, Amex 98,2 % → 98,8 %, Raiffeisen 87,5 % → 89,6 %, Trade Republic unverändert 100 %. Gutschriften (positive Beträge): 15 → 0 Fehler. Der November (neues Bankformat) stieg von 70,5 % auf 96,3 %.

### KI-Prüfung mit dem lokalen Modell (`--model`)

Auf den Buchungen, die Regeln und Belege offen lassen (August bis November, 79 Anfragen an Qwen3-8B):

| | Beispiele: die 30 jüngsten | Beispiele: passend zum Paket |
|---|---:|---:|
| Antworten (nicht „Prüfen“) | 59 | 62 |
| davon richtig (rohe Modellantwort) | 14 (23,7 %) | **21 (33,9 %)** |
| falsch übernommen (sichere Labels, nach Beleg-Gate) | 3 | **2** |

Der Gesamtlauf über alle Monate fragte das Modell zu 201 offenen Buchungen. Es gab 143 Antworten, davon 40 richtig (28,0 %). Das Beleg-Gate übernahm eine weitere richtige Zuordnung und keine falsche (sichere Labels: 88,4 % Präzision, 29 falsch).

Die rohe Trefferquote bleibt niedrig, weil gerade die schweren Fälle übrig sind: anonyme PayPal-Zahlungen, Bargeld, Überweisungen an Personen, Geschäfte mit hausinterner Bedeutung. Das Beleg-Gate ist deshalb unverzichtbar. Ohne Bestätigung durch Historie, Regel oder Branche übernimmt es die Antwort nicht, sondern bietet sie nur als Vorschlag an.

## Analyse: gefundene Fehlerquellen und Änderungen

1. **Revolut-Pocket-Überweisungen im Enable-Banking-Format** (`To EUR MB:<id>`, wahlweise mit eigener Notiz davor). Sie wurden nicht als interne Umbuchung erkannt: Gutschriften galten als Erstattungen, Abbuchungen mit Notiz als Einkauf beim genannten Laden (22 Fehler in einem Monat).
   → `bank-operation.ts` erkennt das Format als „Transfer intern“.
2. **„To“ als Marke:** `brandKey` behandelte Revoluts Richtungswort „To“ als Händler. So galten alle Überweisungen „To …“ als ein Geschäft, und eine Gutschrift wurde als Erstattung eines beliebigen „To …“-Betrags gedeutet.
   → Richtungswörter und Währungen gelten als Füllwörter.
3. **Folgefehler in den echten Daten:** Eine bestätigte Pocket-Überweisung mit Notiz „Billa“ erzeugte über den Händlernamen die Regel „Revolut BILLA = Transfer intern“. Sie bog 20 echte Einkäufe in Umbuchungen um; die fehlten danach in Ausgaben und Budget. Künftige BILLA-Einkäufe landeten wegen der widersprüchlichen Regel in der Prüfliste.
   → `isShopTransferRule`: Eine Transfer-Regel für ein Geschäft mit bekannter Einkaufskategorie wird weder gelernt noch angewandt noch als Widerspruch gewertet.
   → `misfiledShopTransfer` mit der Reparatur in `repairMerchantBookings` stellt die automatisch belegte Einkaufskategorie solcher Buchungen wieder her und entfernt die Regel.
   → Probelauf auf einer Kopie der echten Daten: genau diese 20 Buchungen und 4 Regeln ändern sich, sonst nichts. Die App repariert das beim nächsten Speichern oder Import selbst.
4. **Feste Stichwortregeln gegen die Gewohnheit des Haushalts:** „Trafik = Shopping“ (der Haushalt wählt Freizeit), „Tankstelle = Mobilität“ (der Haushalt wählt Tanken bzw. Snacks) und ein Restaurant-Stichwort für ein Café.
   → Neue Stufe **Gewohnheit** in `evidence.ts` (`keywordHabit`). Sie betrachtet Geschäfte, die dasselbe Stichwort teilen, und wertet die Entscheidungen des Nutzers oder seiner Regeln aus:
   - Bei ähnlichem Betrag mindestens zweimal dieselbe Kategorie und kein Widerspruch: Diese Kategorie gilt.
   - Widerspricht der Haushalt dem Stichwort bei irgendeinem Betrag, entscheidet das Stichwort nicht mehr allein.
   - Ist die übliche Kategorie eine Verfeinerung des Stichworts, gilt sie (Mobilität → Tanken).
5. **`classify` überschrieb gelernte Trafik-Regeln** immer mit Shopping. Jetzt gilt das nur noch für automatische Zuordnungen.
6. **Bestätigter Händlername schaltete die Mittagsregel ab:** Hat der Nutzer den Namen eines Hotspot-, BIPA- oder Mensa-Kaufs bestätigt, blieb die Buchung offen, statt an Werktagen als Mittagessen zu gelten. Das betraf 27 automatische Buchungen.
   → Der Zweck gilt wieder, sofern der Banktext selbst ihn trägt. Für ein Terminal, das der Haushalt anders nutzt, gilt er nur über den bestätigten Namen nicht.
7. **Modellbeispiele ohne Bezug:** Das Modell sah die 30 jüngsten Entscheidungen, nicht die zu den gefragten Geschäften, und las „Hotspot“ als WLAN (21 Mal „Telefon & Internet“).
   → `aiCategoryExamples` stellt Entscheidungen mit gemeinsamen Wörtern voran (lexikalische Suche ohne Embedding-Server).
   → Der Prompt kennt Hotspot als Lokal und kleine Tankstellenbeträge als Snacks.

**Muster:** Fehler häuften sich bei Raiffeisen-Kartenzahlungen (POS-Texte mit Terminalnummern), bei neuen Bankformaten und bei Gutschriften. Revolut und Amex lagen schon vorher bei 98–99 %.

**Bewusst offen gelassen:**
- **Kaltstart:** 19 der 23 verbleibenden Fehler bei Regel-Labels sind Bargeldbehebungen aus Monaten, bevor der Nutzer seine heutige Regel („Sonstiges“) angelegt hat. Damals galt noch die frühere 20-€-Friseur-Regel, die er bei einzelnen Behebungen weiterhin selbst wählt. Hier hat sich die Vorliebe geändert; das ist kein Codefehler.
- **Einzelfälle mit hausinterner Bedeutung**, etwa ein bestimmter Kiosk als Freizeit statt Mittagessen. Sie bleiben ohne frühere Entscheidung offen oder falsch, bis der Nutzer einmal entscheidet; danach greift die Regel.
