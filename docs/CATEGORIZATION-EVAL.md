# Kategorisierungs-Testlauf auf echten Buchungen

`npm run eval:categories` misst, wie genau Finanzblick die **echten** Buchungen des Haushalts kategorisiert. Dafür spielt es jeden Monat so nach, als käme der Kontoauszug gerade erst an. Grundlage ist die lokale Datenbank (`.local-data/finanzblick.sqlite` oder `FINANZBLICK_DATABASE_PATH`), die nur gelesen wird. Echte Buchungen, Händlernamen und Beträge erscheinen ausschließlich in Berichten unter `.local-data/categorization-eval/`. Dieser Ordner ist per `.gitignore` ausgeschlossen. In dieses Dokument und ins Repository kommen nur Summen.

## Ablauf

1. **Monatsweise nachspielen** (`simulateMonth` in `src/lib/ai/categorization-eval.ts`)
   - Bekannt ist nur das Ledger *vor* dem jeweiligen Monat: Buchungen, Fixkosten-Belege, Namensregeln, Urlaubszeiträume, Web-Branchen.
   - Eine Händlerregel des Nutzers existiert erst, sobald er vorher eine Buchung mit diesem Schlüssel selbst kategorisiert oder benannt hat. Eine später gelernte und rückwirkend verteilte Regel sickert so nicht in die Vergangenheit.
   - Die Buchungen des Monats werden auf das reduziert, was ein Kontoauszug liefert (`importSource`): Datum, Text, Rohdetails, Bank-Kategorie, Betrag. Kategorie, Händlername, Regeln und Prüfflags fallen weg.
   - Danach läuft exakt der Weg des Hintergrund-Workers: `enrichTransaction` → `prepareStatementImport` → `commitStatementImport` → `queueLedgerReview` → `assignAfterImport` (Regeln, Historie, Erstattungen, Bank-Paare, Branche – ohne Modell).
   - Gelesen wird das Ergebnis über `actualBookings`, also so, wie die App es anzeigt: inklusive Fixkosten-Belegen und geteilter Urlaube.
   - Führt der Import eine Buchung mit einem Fixkosten-Beleg zusammen, wird sie über ihren Fingerabdruck der verbleibenden Kopie zugeordnet und nicht als „fehlt“ gezählt.
2. **Optional mit Modell** (`--model`): Alles, was danach noch offen ist, geht wie in der App in Achterpaketen an das lokale Modell (`categorizeBookings`). Eine Antwort zählt nur, wenn das Beleg-Gate (`decideReviewWithEvidence`) sie bestätigt. Der Bericht hält zusätzlich die rohe Modellantwort fest. So sieht man, ob das Gate zu streng oder zu locker ist. Voraussetzung ist ein laufender Modellserver (`npm run ai:server`).
3. **Wahrheit** (`evaluationLabels`): Jede Buchung erhält die Kategorie, die die App heute anzeigt, und eine Herkunft:
   - `confirmed`: vom Nutzer selbst gewählt (Stift, Prüfdialog, Assistent).
   - `rule`: Ergebnis einer aktiven Händlerregel des Nutzers.
   - `ai`: früher von der KI-Prüfung entschieden. Diese Entscheidungen sehen in den Daten wie Klicks aus, zählen hier aber nicht als sicher.
   - `accepted`: automatisch vergeben und nie beanstandet.

   Sichere Labels sind `confirmed` und `rule`. Offene Prüfungen, ignorierte Buchungen und Käufe, die eine fehlerhafte Transfer-Regel umgebogen hat (siehe unten), bleiben ohne Wahrheit.
4. **Eingefroren:** Die Wahrheit wird je Datenstand (Revision der Finanzdaten) in `ground-truth.json` gespeichert. Geänderter Code kann so seine eigenen Labels nicht verschieben, und Vorher/Nachher bleiben vergleichbar. Ändern sich die Daten, wird sie neu abgeleitet; `--refresh-labels` erzwingt das.
5. **Urlaubszeiträume** werden getrennt bewertet. Dort zeigt die App unbekannte Ausgaben als Urlaub. Ob ein Geschäft als „daheim“ gilt, hängt aber von späteren Besuchen ab, also von Wissen, das es beim Import noch nicht gab.
6. **Fehlerursache** (`errorCause`): Jeder Fehler bei einem sicheren Label außerhalb von Urlauben erhält eine Ursache.
   - *Regel erst später gelernt:* Das Label stammt aus einer Händlerregel, zu deren Schlüssel es vor diesem Monat keine eigene Entscheidung gab. Der Nutzer hat seine Vorliebe später festgelegt oder geändert, und die App hat sie rückwirkend verteilt. Beim Import war sie nicht bekannt.
   - *Erstentscheidung:* Der Nutzer hat diese Buchung als erste ihres Händlers selbst eingeordnet. Vorher gab es nichts zu lernen.
   - *möglicher Codefehler:* alles andere. Diese Fälle werden einzeln geprüft (`--booking <id>`).
7. **Gegenprobe mit heutigen Regeln** (`trainingState(…, { currentRules: true })`): Alle Buchungen mit später gelernter Regel werden ein zweites Mal nachgespielt, diesmal mit allen heutigen Regeln und allen eigenen Entscheidungen des Nutzers. So zeigt sich, ob die *heutige* Vorliebe richtig angewandt wird. Der Bericht kombiniert beides zur Zeile „Alle sicheren Labels nach heutiger Präferenz“.

## Kennzahlen

| Kennzahl | Bedeutung |
|---|---|
| Präzision | richtige / automatisch entschiedene Buchungen: Wie oft stimmt eine stille Zuordnung? |
| Abdeckung | automatisch entschiedene / bewertete Buchungen: Wie viel bleibt nicht in der Prüfliste? |
| Genauigkeit | richtige / bewertete Buchungen: Eine offene Prüfung zählt hier als „nicht richtig“. |

Präzision hat Vorrang: Eine falsche stille Zuordnung verfälscht Budget und Auswertung. Eine offene Prüfung kostet nur einen Klick.

Zwei Zeilen trennen Codefehler von geänderten Vorlieben:

- **Sichere Labels, beim Import bekannt:** nur Labels, deren Regel oder Entscheidung es beim Import schon gab. Das ist der faire Maßstab für den Code.
- **Alle sicheren Labels nach heutiger Präferenz:** Buchungen mit später gelernter Regel zählen mit dem Ergebnis der Gegenprobe. Das ist der Maßstab für die App, wie sie heute importiert.

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
- Der Markdown-Bericht listet die Fehler bei sicheren Labels nach Ursache (Tabelle je Buchung) und die Gegenprobe mit heutigen Regeln. Die JSON-Datei enthält dieselben Angaben unter `wrong[].cause`, `currentPreferences` und `strongToday`.
- Ohne Datenbank meldet das Skript „nichts zu bewerten“ und endet erfolgreich. CI braucht deshalb keine privaten Daten.
- `src/lib/ai/categorization-eval.test.ts` prüft die Mechanik mit synthetischen Buchungen in `npm test`: Quellreduktion, Herkunft der Labels, Regel-Zeitpunkt, Monatsnachspiel, Modell-Gate, Vergleich.
- Laufzeit ohne Modell: etwa 25 s für rund 3.400 Buchungen.

## Runde 1: Ergebnis (November 2026)

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

## Runde 1: Fehlerquellen und Änderungen

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

**Nach Runde 1 offen:** Bargeldbehebungen aus der Zeit vor der heutigen Bargeld-Regel und Einzelfälle mit hausinterner Bedeutung, etwa ein bestimmter Kiosk als Freizeit statt Mittagessen. Runde 2 hat sie eingeordnet und die echten Codefehler darunter behoben.

## Runde 2: Richtung 100 % (November 2026)

Ziel: mindestens 98 % Präzision bei sicheren Labels, ohne eine vorher richtige Buchung zu verschlechtern. Datenstand: 2.875 bewertete Buchungen, davon 433 mit sicherem Label, dazu 466 in Urlaubszeiträumen. Die älteren Stände liefen mit dem heutigen Testlauf in eigenen Arbeitsbäumen (damaliger Datenstand: 431 sichere Labels).

### Ergebnis ohne Modell

| Labels | `6c082e1` | `4943fde` (Runde 1) | jetzt | falsch |
|---|---:|---:|---:|---:|
| sicher (Hand + Regel) | 80,0 % | 88,7 % | **94,2 %** | 51 → 29 → **15** |
| sicher, beim Import bekannt | 84,5 % | 96,6 % | **98,9 %** | 27 → 6 → **2** |
| sicher, nach heutiger Präferenz | – | – | **99,3 %** | **2** |
| davon selbst gewählt | 77,3 % | 95,0 % | 98,3 % | 27 → 6 → 2 |
| davon Händlerregel | 82,4 % | 83,1 % | 90,4 % | 24 → 23 → 13 |
| frühere KI-Entscheidung | 89,5 % | 95,6 % | 97,9 % | 10 → 4 → 2 |
| automatisch, nie beanstandet | 99,7 % | 99,9 % | **100 %** | 7 → 3 → **0** |
| alle | 97,4 % | 98,7 % | **99,4 %** | 68 → 36 → **17** |
| Urlaubszeiträume (separat) | 97,8 % | 97,8 % | 97,8 % | 10 → 10 → 10 |

- **Gegenprobe:** Alle 108 Buchungen, deren Regel erst später gelernt wurde, landen mit den heutigen Regeln richtig (100 %).
- **Je Buchung gegenüber `4943fde`:** 23 verbessert, keine verschlechtert, keine vorher richtige jetzt offen, keine vorher offene jetzt falsch.
- **Je Buchung gegenüber `6c082e1`:** 81 verbessert, 2 verschlechtert. Das sind die beiden schwachen KI-Labels „Trafik = Shopping“ aus Runde 1; sie folgen jetzt der Kategorie, die der Haushalt bei allen anderen Trafiken wählt.
- Abdeckung: sichere Labels 59,4 % (nach heutiger Präferenz 67,0 %), alle Labels 93,1 %. Nach Bank: Revolut, Amex und Trade Republic 100 % Präzision, Raiffeisen 94,9 %.

### Behobene Codefehler

1. **Automatische Zwecke an offene Zwillinge verteilt** (`commitStatementImport` in `src/lib/import/review.ts`): Der Import übertrug die Kategorie einer neuen Buchung auf offene Buchungen mit demselben Händlerschlüssel, auch wenn sie nur automatisch erkannt war, etwa den Zweck einer Bargeldbehebung.
   → Übertragen werden nur noch Entscheidungen des Nutzers.
2. **„Hotspot“ als Stichwort:** Die feste Regel „Hotspot → Mittagessen“ griff auch bei einem Kiosk-Terminal wie „HOTSPOT 1234“, das der Haushalt als Freizeit führt.
   → Mittagessen nur, wenn der Banktext genau das Mittagslokal nennt (`recurringLunchCategory`).
3. **Tankstellen als Mobilität:** Tankstellen-Stichworte ab 15 € ergaben die breite Kategorie Mobilität.
   → Ab 15 € gilt Tanken. Bezahl-Apps wie PACE bleiben Mobilität.
4. **Café als Restaurant:** Ein Café-Stichwort stand in der Restaurant-Liste.
   → Verschoben zu Cafés & Snacks.
5. **Trinkgeld als Restaurant:** Restaurant-Stichworte bei Beträgen unter 1,50 € (Trinkgeld, Pfand).
   → Bleiben offen.
6. **Eigene Händlerregel ohne Händlernamen:** Regeln des Nutzers für Banktexte ohne erkannten Händler (Bankomat, Terminal) griffen im Beleg-Gate nicht, weil die Anreicherung solche Entwürfe zur Prüfung schickt.
   → Neue erste Gate-Stufe `ownRule` in `evidence.ts`. Sie gilt nicht, wenn die eigenen Entscheidungen des Nutzers für diesen Text auseinandergehen.
   → Eine erste Fassung ohne diese Prüfung verschlechterte 26 Buchungen: ein Supermarkt, in dem der Haushalt sowohl einkauft als auch zu Mittag isst. Der Vergleich je Buchung hat das sofort gezeigt.
7. **Trafik-Standard:** Die feste Regel ordnete Trafiken Shopping zu, der Haushalt wählt durchgehend Freizeit.
   → Standard ist jetzt Freizeit (`categories.ts`, `booking-purpose.ts`, `calc/index.ts`). Gelernte Regeln haben weiter Vorrang.
8. **Möbelhäuser:** IKEA, Mömax und XXXLutz standen unter Wohnen & Haushalt.
   → Eigene Regel „Möbel & Einrichtung“. Baumärkte bleiben Wohnen & Haushalt.
9. **Testlauf:** Eine Buchung, die der Import mit einem Fixkosten-Beleg zusammenführt, galt als „fehlt“.
   → Zuordnung über den Fingerabdruck (siehe Ablauf).
10. **Modell sprach das Stichwort nach** (gefunden im Lauf mit Modell): Das Beleg-Gate übernahm eine Modellantwort, sobald sie zur rohen Stichwortregel passte. So kamen der Hotspot-Kiosk als Mittagessen und ein Trinkgeld als Restaurant doch durch (3 falsche Übernahmen bei sicheren Labels).
   → Das Gate prüft die Modellantwort gegen dieselbe Plausibilität wie die Regel selbst (`plausibleRule`).

Die Fixes 1–8 und 10 haben Unit-Tests in `src/lib/ai/ai.test.ts`, `src/lib/categories.test.ts` und `src/lib/import/manual-category-authority.test.ts`; die Ursachen-Einordnung und die Gegenprobe prüft `src/lib/ai/categorization-eval.test.ts`.

### Verbleibende Fehler eingeordnet

| Klasse | Anzahl | Erklärung |
|---|---:|---|
| Codefehler | **0** | – |
| Geänderte Präferenz | 13 | 12 Bargeldbehebungen zu 20 € aus Monaten vor der heutigen Bargeld-Regel „Sonstiges“. Damals galt die frühere Konvention (Körperpflege), und die App wandte sie beim Import richtig an. Dazu eine Kartenzahlung, deren Händlerregel der Nutzer erst später angelegt hat. Mit heutigen Regeln nachgespielt sind alle 13 richtig. |
| Erstentscheidung | 2 | Der Nutzer hat jeweils die erste Buchung eines Händlers anders eingeordnet als dessen übliche Branche (Supermarkt als Café, Online-Bestellung als Möbel). Beim Import nicht erkennbar; danach greift seine Regel. |
| Unklar oder zeitabhängig | 10 | Ausgaben in eingetragenen Urlaubszeiträumen, etwa eine Ladesäule, Parken oder eine Überweisung als Geschenk. Die App zeigt unbekannte Ausgaben dort bewusst als Urlaub; was „daheim“ ist, ergibt sich erst aus späteren Besuchen. Deshalb getrennt bewertet und nicht geändert. |

### KI-Prüfung mit dem lokalen Modell (`--model`)

Alle Monate, Qwen3-8B auf der NPU, etwa 15 Minuten:

| | vor Fix 10 | nach Fix 10 |
|---|---:|---:|
| offene Buchungen gefragt | 198 | 198 |
| Antworten (nicht „Prüfen“) | 127 | 127 |
| davon richtig (rohe Modellantwort) | 33 (26,0 %) | 33 (26,0 %) |
| sichere Labels: Präzision | 93,1 % | **94,2 %** |
| sichere Labels: falsch übernommen durch das Modell | 3 | **0** |
| sichere Labels, beim Import bekannt | 98,4 % | **98,9 %** |
| sichere Labels nach heutiger Präferenz | 99,0 % | **99,3 %** |

Mit Modell bleibt die Präzision so hoch wie ohne. Das Gate übernimmt nur, was Historie, Regel oder Branche bestätigt; eine weitere Buchung wird dadurch richtig entschieden. Die rohe Trefferquote des Modells bleibt niedrig, weil nur die schweren Fälle übrig sind (siehe Runde 1).

### Fazit

- **Ziel erreicht:** 98,9 % Präzision bei sicheren Labels, die beim Import bekannt waren, und 99,3 % nach heutiger Präferenz. Ohne Urlaube gibt es keinen bekannten Codefehler mehr.
- **Keine Verschlechterung:** Gegenüber Runde 1 ist keine vorher richtige Buchung falsch oder offen geworden.
- **Offen bleibt die Abdeckung:** Rund ein Drittel der sicheren Labels landet weiter in der Prüfliste. Das sind vor allem Erstkäufe, Überweisungen an Personen und anonyme Zahlungen. Hier ist eine Rückfrage richtiger als eine stille Vermutung.
