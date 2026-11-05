# Lokale KI (NPU)

Finanzblick kann offene Buchungsprüfungen mit einem lokalen Sprachmodell erledigen. Das Modell läuft auf der Intel-NPU (Core Ultra, „Intel AI Boost“). Es arbeitet vollständig offline: Finanzdaten verlassen den Rechner nicht.

## Komponenten

| Teil | Aufgabe |
| --- | --- |
| OpenVINO Model Server (OVMS) | Stellt `Qwen3-8B-int4-cw-ov` auf der NPU als OpenAI-kompatible API unter `http://127.0.0.1:8000/v3` bereit |
| `AiReviewAssistant` (Browser) | Schickt offene Prüfungen in Achterpaketen an `/api/ai/categorize` und übernimmt nur sichere Antworten |
| `/api/ai/logo` | Sucht ein Händlerlogo (Wikidata/Commons, offizielle Webseite, Marken-Domain) und legt es in den privaten `Logo/`-Ordner |
| `/api/ai/logos` | Sucht der Reihe nach Logos für alle Zahlungsempfänger, die noch keines haben (siehe „Händler-Logos“) |
| `/api/ai/web-categories` | Schlägt den Geschäftstyp unbekannter Händler bei OpenStreetMap, Wikidata oder auf der Händler-Webseite nach (braucht kein Modell) |
| `npm run mcp` | MCP-Server (stdio) mit Finanzwerkzeugen für Claude Desktop, VS Code, Copilot oder den lokalen Agenten |
| `npm run ai:agent` | Freier Chat mit dem lokalen Modell, das die MCP-Werkzeuge selbst aufruft |

Qwen3-8B ist das stärkste Modell, das OpenVINO für die NPU vorbereitet bereitstellt. Es beherrscht Deutsch, Werkzeugaufrufe und JSON-Ausgaben, deshalb taugt es auch für spätere Aufgaben.

## Einrichtung

```powershell
npm run ai:server   # lädt OVMS-Modell beim ersten Start (~5 GB), danach nur Start
```

- OVMS einmalig installieren: `ovms_windows_python_off.zip` von den [Model-Server-Releases](https://github.com/openvinotoolkit/model_server/releases) nach `%LOCALAPPDATA%\FinanzblickAI` entpacken (ergibt den Ordner `ovms`).
- `scripts/ai-server.ps1` lädt das Modell nach, wenn `%LOCALAPPDATA%\FinanzblickAI\models\config.json` fehlt.
- Der erste NPU-Start kompiliert das Modell einige Minuten lang. Danach nutzt OVMS den Cache `.ov_cache`.
- Bereit ist der Server, wenn `http://127.0.0.1:8000/v1/config` den Status `AVAILABLE` meldet.
- Ohne NPU: Ordner `models` löschen und `npm run ai:server -- -Device GPU` (oder `CPU`) starten.

Optionale Variablen in `.env.local`:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `FINANZBLICK_AI` | `true` | `false` schaltet die KI ab |
| `FINANZBLICK_AI_URL` | `http://127.0.0.1:8000/v3` | Nur Loopback-Adressen sind erlaubt |
| `FINANZBLICK_AI_MODEL` | `OpenVINO/Qwen3-8B-int4-cw-ov` | Modellname in OVMS |
| `FINANZBLICK_AI_MIN_CONFIDENCE` | `90` | Mindestsicherheit (50–100) für automatische Übernahme |
| `FINANZBLICK_AI_TIMEOUT_MS` | `180000` | Zeitlimit pro Modellanfrage |
| `FINANZBLICK_MCP_USER` | `admin` | Konto, auf das MCP-Server und Agent zugreifen |

## Was automatisch passiert

1. Das Dashboard prüft jede Minute, ob das Modell bereit ist.
2. Offene Buchungsprüfungen gehen in Achterpaketen an das Modell, zusammen mit bis zu 30 eigenen früheren Entscheidungen als Beispiele.
3. Eine Antwort wird nur übernommen, wenn alle diese Bedingungen erfüllt sind:
   - Die Kategorie existiert.
   - Das Vorzeichen passt (Einnahmen positiv, Ausgaben negativ).
   - Die Sicherheit erreicht die Schwelle.
   - Für Gehalt, Einkommen, Rufbereitschaft, Rückerstattungen und Transfers sind mindestens 97 % nötig.
   - Bei Zahlungsdiensten wie PayPal oder Klarna, die den Händler verdecken, gilt die Antwort nie als sicher.
   - Die Antwort besteht die Plausibilitätsprüfung in `plausibilityIssue`. Die Sicherheitsangabe des Modells allein reicht nicht, weil es auch falsche Antworten mit über 95 % meldet.
4. Die Plausibilitätsprüfung lehnt eine Antwort ab, wenn eine dieser Regeln greift:
   - Der Text ist eine Bargeldbehebung (ATM, Bankomat, SB-Behebung).
   - Ein Zahlungsdienst steht im Text, aber das Modell nennt keinen Händler.
   - Die Kategorie widerspricht der festen Händlerregel aus `categories.ts`. Erlaubt sind nur Verfeinerungen, etwa Mobilität → Tanken.
   - Die Kategorie gehört zu den Regel-Kategorien und keine Regel passt. Das betrifft Bankgebühren, Rücklastschriftgebühren, Guthabenkarten, Leasing, Miete, Versicherungen, Einkommen, Transfers und Sonstiges.
   - Der genannte Händler kommt im Buchungstext nicht vor, etwa „VILLACH“ als Ort statt H&M.
   - Der Händlername beginnt mit dem Ort am Ende des Kartentexts, etwa „VILLACH“ bei „VILLACH ATRIO SHOPPING VILLACH“.
   - Tanken unter 10 € wird abgelehnt, weil kleine Tankstellenbeträge meist Snacks sind.
5. Danach folgt das Beleg-Gate in `src/lib/ai/evidence.ts`. Es prüft in dieser Reihenfolge, und die ersten drei Stufen brauchen kein Modell:
   - **Historie:** Alle bisherigen Buchungen des Händlers mit demselben Vorzeichen liegen in einer Kategorie, und mindestens eine davon ist bestätigt. Dann gilt diese Kategorie.
   - **Erstattung:** Eine Gutschrift derselben Marke (höchstens 180 Tage nach dem Kauf) übernimmt die Kategorie des Kaufs. Exakte Beträge haben Vorrang. Kleinere Beträge zählen als Teil-Erstattung, etwa „OBI SAGT DANKE +19,51 €“. Der Kauf muss schon entschieden sein; ist er selbst noch offen, folgt die Gutschrift, sobald er bestätigt ist.
   - **Feste Bank-Paare** (`src/lib/ai/booking-matchers.ts`):
     - Amex-Vorteilsgutschriften („Entertainment“, „Gourmet“ …) → Rückerstattungen.
     - Amex „RÜCKLASTSCHRIFT“ und „Zahlung erhalten“ mit gleichem Betrag innerhalb von 14 Tagen → beide „Transfer intern“.
     - Amex „SONSTIGE GUTSCHRIFT“ / „UMBUCHUNG DER BELASTUNG“ → Rückerstattungen, wenn genau eine Amex-Abbuchung desselben Betrags in den 30 Tagen davor liegt.
     - Anonyme PayPal-Gutschrift („YYW…/PAYPAL“) → Rückerstattungen, wenn eine PayPal-Abbuchung desselben Betrags am selben Konto höchstens 60 Tage davor liegt.
     - Überweisung von Raphael mit Notiz → Kostenbeteiligung in der passenden Kategorie (Tanken, Cafés & Snacks, Urlaub, Parken & Maut, Geschenke, Restaurants, Lebensmittel, Shopping, Energie). Nur ein Stichwort darf passen. Rückzahlungen geteilter Buchungen bleiben dem Ausgleich zugeordnet.
   - **Feste Händlerregel:** Die Regel aus `categories.ts` gilt direkt, etwa dm → Drogerie oder G2A → Guthabenkarten. Das Modell darf sie nur verfeinern (Mobilität → Tanken). Die Regel gilt nicht, wenn das Vorzeichen nicht passt, wenn Mobilität oder Tanken unter 15 € liegt oder wenn bestätigte Buchungen des Händlers eine andere Kategorie haben.
   - **Internet (OpenStreetMap):** Für Kartenzahlungen an unbekannten Geschäften liest `src/lib/ai/web-categories.ts` Name, Ort und Postleitzahl aus dem Banktext (etwa „MARTIN AUER ATRIOVIL VILLACH 9500“). `src/lib/ai/industry.ts` fragt dann OpenStreetMap (Nominatim) nach dem Geschäftstyp unter diesem Namen an diesem Ort, etwa `amenity=pharmacy` → Gesundheit. Läuft ohne Modell, siehe [Internet-Kategorisierung](#internet-kategorisierung).
   - **Branche:** Findet OpenStreetMap nichts, sucht `industry.ts` die Branche auf Wikidata (genau ein Eintrag mit exakt gleichem Namen) oder auf der Startseite des Shops (`www.<name>.de/.at/.com`, nur HTTPS, keine fremden oder geparkten Domains). Stimmen Branche und Modell überein, wird zugeordnet; ohne Modell wird sie nur vorgeschlagen. Vorübergehende Fehler wie Drosselung werden nicht zwischengespeichert.
   - Alles andere bleibt zur manuellen Prüfung offen und erhält einen Vorschlag.
   - Der Browser-Assistent wendet Historie, Erstattung, Bank-Paare und Regel auch ohne laufendes Modell an.
   - **Schon beim Import:** Diese modellfreien Stufen laufen direkt nach jedem Upload (Browser und Hintergrund-Worker). Die Prüfliste kommt dadurch bereits verkleinert an.
6. **PayPal und Klarna:** `providerMerchant` liest den Shop hinter dem Zahlungsdienst aus dem Text, etwa „PAYPAL \*ZALANDO“ → Zalando. Ohne erkennbaren Shop (zum Beispiel „PAYPAL EEA“) bleibt die Buchung offen.
   - **PayPal-Kontoauszug:** Bei anonymen Buchungen wie „1051861566294/PAYPAL“ zeigt der Prüfdialog „PayPal-CSV abgleichen“. Dort lädst du den PayPal-Export (Aktivitäten → Herunterladen → CSV) hoch. Jede Buchung mit gleichem Betrag und höchstens 4 Tagen Abstand erhält den Shop als Namen, aber nur, wenn alle passenden PayPal-Zahlungen denselben Empfänger haben. Danach greifen Historie und Regeln erneut. Die CSV wird nicht gespeichert.
   - **Abo-Vorschlag:** Derselbe anonyme PayPal-Betrag (ab 1,50 €) in mindestens drei Monaten wird als „Abonnements“ vorgeschlagen, aber nicht automatisch übernommen.
7. **Vorschläge im Prüfdialog:** Für jede offene Prüfung wird ein Vorschlag aus Historie, Regel, Abo-Muster, Branche oder Modell (ab 50 % Sicherheit) in `appState.aiSuggestions` gespeichert. Der Dialog füllt die Kategorie damit vor; ein Klick bestätigt. Bestätigte Buchungen zählen danach als Historie.
8. **Gruppen:** Offene Prüfungen derselben Marke und Richtung (ab zwei) erscheinen als Gruppe. „Alle N übernehmen“ ordnet die ganze Gruppe mit einer Entscheidung zu, „Einzeln prüfen“ zeigt die Buchungen einzeln.
9. Übernommene Antworten werden committet, ohne dass eine Händler- oder Namensregel entsteht. Sie werden nie auf gleichnamige andere Buchungen übertragen. Die Buchung erhält `aiAssigned: true`. Eine manuelle Kategorieänderung entfernt die Markierung.
10. Das Modell antwortet als JSON-Liste. Fehlerhafte Einträge werden einzeln verworfen, und fehlende Antworten werden einzeln nachgefragt.
11. Für neu erkannte Händler wird das Logo gesucht und privat in `Logo/` abgelegt. Der Live-Logo-Sync übernimmt es.
12. Ein Hinweis meldet, wie viele Buchungen zugeordnet wurden und wie viele zur manuellen Prüfung bleiben.

Nie automatisch bearbeitet werden Prüfungen mit Importproblemen, OCR-Hinweisen, fehlendem Betrag oder Datum, Amex-Screenshots und fehlendem POS-Händler. Diese brauchen Daten vom Nutzer.

Beim Import werden Bank-Texte vereinheitlicht: Kleingeschriebene Umlaute in Großbuchstaben-Wörtern („GEBüHREN FüR“) werden zu „GEBÜHREN FÜR“, damit Regeln wie Rücklastschriftgebühren greifen.

## Auswertungen

Die Übersicht zeigt den Block „KI-Einblicke“ (`src/lib/insights.ts`), der ohne Modell rechnet:

- **Abos:** mindestens drei monatliche oder zwei jährliche Abbuchungen mit ähnlichem Betrag (±25 %). Beendete Abos fallen weg. Preisänderungen ab 2 % und 0,50 € werden gemeldet.
- **Doppelte Abbuchungen:** gleicher Text und Betrag (ab 5 €) innerhalb von drei Tagen in den letzten 60 Tagen.
- **Budgetprognose:** Hochrechnung der Ausgaben des laufenden Monats.
- **Monatszusammenfassung:** `/api/ai/summary` lässt das Modell einen kurzen Text aus festen Zahlen schreiben. Der Text wird nur verwendet, wenn jede Zahl darin aus den übergebenen Fakten stammt. Sonst erscheint ein regelbasierter Text.
- **Lernkurve („Automatisch zugeordnet“):** Pro Import (`appState.aiLearning`, max. 200 Einträge) der Anteil der Zeilen, die ohne manuelle Prüfung zugeordnet wurden: direkt importiert, beim Import automatisch zugeordnet oder später durch die KI. Dazu die Händler, die am häufigsten offen bleiben.

## Finanz-Assistent

Eigene Seite `/assistent` im Seitenmenü (`src/components/finance-assistant.tsx`).

- **Nur Extraktion:** `/api/ai/assistant` (`src/lib/ai/assistant.ts`) lässt das Modell aus dem Freitext nur Absicht und Angaben herauslesen (Ziel, Betrag, Datum, Konto, Startkapital, Raten). Jede Angabe muss im Text vorkommen (`groundModelExtraction`), sonst wird sie verworfen. Ohne KI oder bei Fehlern übernimmt der Regel-Parser (`src/lib/assistant/intent.ts`). Fehlt eine Angabe, fragt der Assistent nach.
- **Konten, Amex, Monatsplan:** Kontostände, die Amex-Abrechnung (offener Saldo minus Rückzahlungs-Pocket, gleiche Rechnung wie im Dashboard) und der Monatsplan kommen direkt aus `calculateDashboard` (`src/lib/assistant/accounts.ts`). Ausgabenfragen verstehen Zeiträume wie „seit 11.10.“ und Konten wie „mit Amex“.
- **Folgefragen und Vergleich:** Kurze Nachfragen wie „und im September?“, „und mit Amex?“ oder „warum so viel?“ übernehmen Kategorie, Händler, Konto und Monat der vorherigen Frage (`src/lib/assistant/followup.ts`, ohne Modellaufruf). „Vergleich Oktober mit September“ oder „Mehr als im Vormonat?“ stellt zwei Monate gegenüber und nennt die größte Veränderung.
- **Ausgabenverlauf:** „Wie haben sich meine Ausgaben entwickelt?“ zeigt die letzten 6 vollen Monate (oder „letzte N Monate“) mit Abweichung zum Schnitt, dem teuersten und günstigsten Monat. Kategorie, Händler und Konto gelten auch für Nachfragen wie „und fürs Essen?“.
- **Finanz-Check:** „Bin ich sparsam?“ oder „Wie stehe ich finanziell da?“ bewertet die letzten drei vollen Monate als Ampel (`src/lib/assistant/check.ts`): Sparquote (Ziel ≥ 20 %), Fixkosten-Anteil (≤ 50 %), Reserve in Monatsausgaben (≥ 3), Ausgaben des letzten Monats gegenüber den zwei davor, Abos und offene Amex-Rückzahlung. Einkommen kommt aus dem Monatsplan, Rückerstattungen mindern die Ausgaben.
- **Bedienung:** Mit Pfeil-hoch im leeren Eingabefeld holst du die letzte eigene Nachricht zurück.
- **Freie Fragen:** Passt kein Werkzeug, beantwortet `/api/ai/answer` die Frage nur aus fertig gerechneten Fakten (`src/lib/assistant/facts.ts`). Jede Zahl in der Antwort muss in den Fakten stehen (`numbersBacked`), sonst bittet der Assistent um eine andere Formulierung.
- **Feste Rechnung:** `src/lib/assistant/plan.ts` rechnet mit dem Monatsplan: Monatsrate bzw. erreichbares Datum für Sparziele, Konflikte mit bestehenden Zielen, Monate ohne volle Rate.
- **„Kann ich mir das leisten?“:** Ampel aus dem frei verfügbaren Betrag über dem Sparsockel. 🟢 reicht, 🟡 nur mit ausgesetzter Sparrate, 🔴 Fehlbetrag mit Alternativen (Raten, späterer Monat, Rücklage vom Sparkonto).
- **Nichts automatisch:** Gespeichert wird erst bei „Anlegen“. „Ändern“ öffnet ein Formular, „Was-wäre-wenn“-Fragen werden nur berechnet.
- **Verlauf:** `appState.assistantChat` (max. 100 Nachrichten) in der lokalen Datenbank, nicht im Excel-Backup.

### Agent

Die KI wählt nur ein Werkzeug (`src/lib/assistant/tools.ts`) und nennt Namen aus dem mitgeschickten Kontext (Ziel-, Ausgaben-, Kategorie- und Händlernamen). Namen, die weder im Kontext noch im Text vorkommen, werden verworfen. Klare Befehle („rückgängig“, „merk dir“, „ist immer“) erkennt der Regel-Router auch ohne Modell. Ausgeführt wird alles in `src/lib/assistant/agent.ts`.

- **Fragen zu den Daten** (`answers.ts`): Summe, Aufteilung, größte Ausgabe, Einnahmen, Abos, Anzahl, Durchschnitt für Monat, Woche, „letzte N Monate“ oder Jahr. Unter der Antwort lassen sich die zugrunde liegenden Buchungen aufklappen.
- **Bestehendes ändern:** Sparziele (Betrag, Datum, Rate, Name, Rate in Monaten aussetzen, Extra-Beträge, erreicht, löschen), geplante Ausgaben (verschieben, Betrag, Raten, umbenennen, löschen, „Zahl das Pickerl vom Sparkonto“, „Teil das Pickerl mit Raphael“), Notgroschen-, Urlaubs- und Sparkonto-Ziel. Erlaubt sind nur die Operationen aus `assistantOperationSchema`.
- **Buchungen bearbeiten:** „Benenne BILLA DANKT in Billa um“ (Anzeigename), „Nimm die Buchung vom 3.11. aus dem Plan“, „Netflix ist Fixkosten“, „Markier alle Billa-Buchungen als geprüft“. Auswahl über Händler, Datum („vom 3.11.“), Betrag („die 12,99 €“) oder Zeitraum; die Karte listet die betroffenen Buchungen. Operation `transaction_update`, rückgängig machbar (`src/lib/assistant/bookings.ts`).
- **Mehrere Befehle auf einmal:** „Erhöhe Japan auf 4.000 € und schieb es auf August“ oder durch „;“/Satzende getrennt. Jeder Teil muss für sich eine Änderung sein (Ziel/Ausgabe, Buchung, Regel, Merken, Vergessen, Erinnerung); ohne Namen gilt der Name des vorigen Teils. Alles kommt in eine Vorschau und ist ein Rückgängig-Schritt.
- **Extra-Beträge für Sparziele:** „die ersten 2 Monate je 60 € vom Sparkonto“ (beim Anlegen) oder „Nimm für Japan die nächsten 3 Monate je 50 € extra aus dem Notgroschen“ (bei bestehenden Zielen) wird zur Operation `goal_extras`. Die Beträge landen in `funding.extras` und kommen zur Monatsrate dazu, die Rate eines neuen Ziels sinkt entsprechend. Kommt das Geld aus einem Pocket, wird es dort im selben Monat als Entnahme (`pocketOut`) eingeplant; ohne Quelle oder „vom Giro“ kommt es aus dem laufenden Konto. „Keine Extras mehr für Japan“ entfernt sie. Rückgängig stellt Ziel und Monate wieder her. Ziele ohne feste Rate werden automatisch befüllt und bekommen keine Extras.
- **Dashboard erklären** (`explain.ts`): „Wie funktionieren die Sparziele?“ oder „Was kann ich im Dashboard alles einstellen?“ antwortet mit festen Texten zu Seiten und Rechenlogik (Sparziele, Pockets, geplante Ausgaben, Umsätze und Import, Monatsplan, Budget, Gehalt und Steuern, Einstellungen, Assistent), den aktuellen Werten und Beispielsätzen, mit denen man den Bereich per Chat ändert.
- **Vorschau und Rückgängig** (`operations.ts`): Die Karte zeigt Vorher/Nachher, angewendet wird erst bei „Bestätigen“. Jede Änderung (auch im Chat angelegte Ziele und Ausgaben) kommt in `appState.assistantChanges` (max. 200) mit einem Schnappschuss genau der betroffenen Einträge und lässt sich einzeln zurücknehmen.
- **Wochenüberblick:** Beim Öffnen einmal pro Tag: fällige Abos und geplante Ausgaben der nächsten 7 Tage, Preiserhöhungen, Ziele hinter Plan, doppelte Abbuchungen, Monatsprognose, offene Prüfungen, noch offene Amex-Rückzahlung und ein Monat im Minus.
- **Bedienelemente:** Schieberegler für Datum, Rate, Monat und Raten, Balkendiagramm „frei pro Monat vorher/danach“ für 12 Monate und Vergleich zweier Varianten.
- **Spar-Coach:** Vorschläge mit Betrag aus Abos und frei gestaltbaren Kategorien (Durchschnitt der letzten 3 Monate) bis zum Wunschbetrag.
- **Regeln per Chat:** „Lieferando ist immer Lieferdienste“ zeigt die betroffenen Buchungen und legt nach Bestätigung eine Händlerregel an. Mit Zeitraum („im Oktober“) gilt es nur für diese Buchungen.
- **Gedächtnis:** `appState.assistantMemory` (max. 50), einsehbar und löschbar. Der Puffer wird bei „Kann ich mir das leisten?“ abgezogen, der Gehaltstag erscheint im Wochenüberblick.
  „Merk dir …“ wird sofort gespeichert. Zusätzlich liest `extractMemories` (`src/lib/assistant/memory.ts`) aus jeder Nachricht dauerhafte Fakten heraus, etwa Gehaltstag, Puffer oder Aussagen wie „Ich wohne in Wien“, und speichert höchstens drei davon. Fragen, Pläne, einmalige Ereignisse und bereits bekannte Fakten werden ignoriert. Jeder Eintrag erscheint als „Gemerkt: …“ mit dem Button „Nicht merken“.
- **Freie Formulierungen:** `normalizeMessage` (`src/lib/assistant/normalize.ts`) vereinheitlicht jede Nachricht, bevor Router, Werkzeugwahl und Parser sie lesen. Es ersetzt Umlaute in ASCII-Schreibweise (fuer → für), Umgangssprache (wv, nen, tv, krieg), Monatskürzel, kurze Jahreszahlen (Juli 27 → Juli 2027), Kurzbeträge (3k, 1,5k) und Regelkürzel („X = Y“ → „X ist immer Y“). Die Abdeckung prüft `phrasing.test.ts`.
- **Depot-Rechner:** Endwert bei 3 %, 5 % und 7 % p. a. mit monatlicher Verzinsung. Mit Live-Daten kommt der mittlere Wert zusätzlich in heutiger Kaufkraft dazu. Eine reine Rechnung, keine Anlageberatung.
- **Kreditrechner:** „Kredit 10.000 € auf 5 Jahre zu 6 %“, „Laptop 1.200 € in 12 Raten mit 9,9 %“, „Leasing 20.000 € 48 Monate“. Annuität mit festem Sollzins: Monatsrate, Zinsen gesamt, Vergleich mit Ansparen und Anteil am freien Geld des Monats. Ohne Zinsangabe werden 4 %, 7 % und 10 % verglichen, ohne Laufzeit 5 Jahre angenommen (`src/lib/assistant/extras.ts`).
- **Erinnerungen:** „Erinner mich am 1. Dezember, die Kfz-Versicherung zu kündigen“ (auch „morgen“, „in 2 Wochen“, „nächsten Montag“, „Ende des Monats“, „im März“). Gespeichert als Gedächtnis-Eintrag `key: "reminder"` mit `due`, bestätigt per Karte, rückgängig machbar. Fällige und überfällige erscheinen oben im Wochenüberblick; „Welche Erinnerungen habe ich?“ listet alle, „Vergiss die Erinnerung Kfz“ löscht.
- **Jahresrückblick:** „Wie war mein Jahr 2026?“, „Jahresrückblick letztes Jahr“. Einnahmen, Ausgaben, Sparquote, Top-5-Kategorien, größte Ausgabe, Händler mit dem meisten Geld, teuerster/sparsamster Monat und Ausgaben gegenüber dem gleichen Zeitraum im Vorjahr.
- **Marktdaten aus dem Internet:** „Wie hoch ist die Inflation?“, „Welche Zinsen bekomme ich fürs Sparkonto?“, „Wie viel sind 3.000 € in Yen?“, „Was sind 10.000 € in 10 Jahren wert?“. Der Browser holt die Werte über `/api/market` vom MCP-Server `finanzblick-web` (siehe unten), `src/lib/assistant/market.ts` rechnet damit (Kaufkraftverlust und Zinsen auf die Reserve, Umrechnung, Zinsvergleich). Ohne Internet sagt der Assistent das, statt Zahlen zu raten.
- **Dazulernen:** Der Assistent lernt auf zwei Wegen selbst dazu, alles liegt nur in deiner Datenbank und steht unter „Gedächtnis“ zum Einsehen und Löschen.
  - *Wissen aus dem Internet:* Begriffsfragen wie „Was ist ein ETF?“, „Was bedeutet KESt?“ oder „Unterschied zwischen Tagesgeld und Festgeld“ schlägt er über `/api/knowledge` und das MCP-Werkzeug `search_knowledge` nach und speichert die Erklärung (`assistantKnowledge`, höchstens 100 Einträge). Beim nächsten Mal antwortet er sofort und auch offline; nach 90 Tagen frischt er den Eintrag auf. Gelerntes Wissen fließt auch in freie KI-Antworten ein. Ins Internet geht nur der Begriff. Fragen zu eigenen Daten oder zum Dashboard („Was ist ein Pocket?“, „Was sind meine Abos?“) bleiben bei den anderen Werkzeugen. „Was hast du gelernt?“ zeigt alles.
  - *Formulierungen:* Versteht nur die KI eine Nachricht (die Regeln nicht), merkt er sich die Formulierung mit dem gewählten Werkzeug, Beträge als Platzhalter (`assistantPhrases`, höchstens 200). Die gleiche Formulierung beantwortet er danach ohne NPU-Aufruf. Das gilt nur für Werkzeuge, die allein aus dem Text rechnen, nicht für Änderungen oder Entwürfe.
- **Selbst lernend** (`src/lib/assistant/learning.ts`):
  - *Feedback:* 👍 unter einer Antwort merkt sich die Formulierung für das gewählte Werkzeug. 👎 vergisst sie, notiert die Frage als offen und fragt „Was hast du gemeint?“. Die Antwort darauf (oder „Nein, ich meinte …“) lernt die ursprüngliche Formulierung für das richtige Werkzeug.
  - *Eigene Bezeichnungen:* „Mit Japan meine ich Motorrad“ speichert eine Bezeichnung (`assistantAliases`, höchstens 100), die vor jeder Nachricht eingesetzt wird. Kennt er einen Namen nicht und du wählst bei „Welches meinst du?“ eines aus, merkt er sich das unbekannte Wort automatisch und führt den Befehl mit dem richtigen Namen aus.
  - *Offene Fragen:* Was er nicht versteht, kommt in `assistantGaps` (höchstens 50). Beim Öffnen versucht er bis zu drei offene Fragen erneut, mit Regeln und KI, und lernt sie, wenn es klappt. „Was kannst du noch nicht?“ und „Gedächtnis“ zeigen Bezeichnungen und offene Fragen.
- **Arbeitnehmerveranlagung (Österreich):** Spenden, Kirchenbeitrag, Gewerkschaft, Fortbildung, Arbeitsmittel und Krankheitskosten eines Jahres als Liste. Ersetzt keine Steuerberatung.
- **Home-Office-Rechner (Österreich):** „Was bekomme ich für meine Home-Office-Sachen zurück?“ öffnet eine Karte im Chat. Du wählst die Käufe aus (Vorschläge plus Suche über alle Ausgaben des Jahres), gibst je Buchung an, was es war, und trägst Homeoffice-Tage, die Telearbeitspauschale vom Arbeitgeber und das Jahreseinkommen ein. Das Einkommen wird aus den Lohnzetteln geschätzt. Gerechnet wird in `src/lib/assistant/homeoffice.ts`:
  - Geräte mit 40 % Privatanteil (änderbar).
  - Ab 1.000 € Abschreibung über 3 Jahre, bei Kauf im zweiten Halbjahr mit Halbjahres-AfA.
  - Ergonomisches Mobiliar (Schreibtisch, Bürostuhl, Beleuchtung) bis 300 € pro Jahr ab 26 Homeoffice-Tagen; der Rest geht in die Folgejahre.
  - Telearbeitspauschale als Differenz: 3 € pro Tag, höchstens 100 Tage, minus die Zahlung vom Arbeitgeber.
  - Die Werbungskostenpauschale von 132 € wird abgezogen.
  - Die Erstattung ergibt sich aus dem Tarif 2025, 2026 oder 2027 bzw. aus dem Grenzsteuersatz.

  Das Ergebnis ist eine Schätzung, keine Steuerberatung.

## Internet-Kategorisierung

Der Browser-Assistent schlägt unbekannte Geschäfte offener Kartenzahlungen selbst im Internet nach, auch ohne laufendes Modell (`/api/ai/web-categories`, je 8 Geschäfte, jedes nur einmal).

- **Was nachgeschlagen wird:** Nur Ausgaben mit erkennbarem Geschäft, also Raiffeisen-Kartenzahlungen (`Verwendungszweck: … Zahlungsreferenz: POS`), Amex-Texte und der Shop hinter PayPal/Klarna. Überweisungen (IBAN, Empfänger, Dauerauftrag …) nennen Personen und werden nie nachgeschlagen.
- **Quellen der Reihe nach:**
  - OpenStreetMap: Name plus Ort. Der Treffer muss den Namen tragen (abgeschnittene Wörter wie „RESTAURA“ zählen als Wortanfang) und an der Postleitzahl bzw. im Ort der Buchung liegen. Haben gleichnamige Treffer verschiedene Branchen, bleibt es offen.
  - Wikidata.
  - Die Webseite des Händlers.
- **Wann automatisch zugeordnet wird:** Nur eindeutige Geschäftstypen ordnen direkt zu, etwa Apotheke, Supermarkt, Restaurant, Tankstelle (ab 15 €), Friseur, Baumarkt oder Werkstatt.
- **Wann es nur ein Vorschlag ist:** Bei mehrdeutigen Typen wie Bäckerei, Hotel, Bar, Blumenladen oder Buchhandlung und bei Wikidata- bzw. Webseiten-Treffern wird die Kategorie nur im Prüfdialog vorgeschlagen.
- **Eigene Entscheidungen gehen vor:** Bestätigte Buchungen desselben Händlers mit anderer Kategorie verhindern die Zuordnung.
- **Gewohnheiten:** Hast du mindestens zwei verschiedene Geschäfte desselben Typs gleich eingeordnet (z. B. zwei Bäckereien als Mittagessen), gilt das ab dann für alle Geschäfte dieses Typs und ordnet automatisch zu.
- **Gedächtnis:** Ergebnisse speichert der Zustand in `webCategories` (max. 3000), also bleiben sie über Neustarts erhalten. „Nichts gefunden“ wird nach 30 Tagen erneut versucht.
- **Höflich zu den Diensten:** Nominatim bekommt höchstens 1 Anfrage pro Sekunde, Wikidata höchstens 2. Nach einer Drosselung (HTTP 429/503) pausiert der Dienst bis `Retry-After`, sonst 10 Minuten, und die Geschäfte kommen später erneut dran.

## Händler-Logos

Der Browser-Assistent sucht nach dem Laden im Hintergrund Logos für alle Zahlungsempfänger, deren Buchungen ein Händlerzeichen zeigen würden, aber noch keines haben (`/api/ai/logos`, je 5 Händler, bis zu 40 Runden, meiste Buchungen zuerst). Neue Logos erscheinen sofort.

- **Wer ein Logo bekommt:** Händlernamen (Alias) und Geschäfte aus Kartenzahlungen. Überweisungen an Personen, Umbuchungen, Gebühren und reine Branchenwörter („Tankstelle“, „Hotel“) nicht.
- **Suchnamen:** Aus „SPAR Fil. 6423 Spar Fil Finkenstein“ werden der Reihe nach „Spar Finkenstein“ und „Spar“ gesucht. Der Dateiname besteht so nur aus Wörtern der Buchung und passt später sicher.
- **Quellen der Reihe nach:**
  1. Wikidata-Logo (P154) von Wikimedia Commons.
  2. Icon der offiziellen Webseite aus Wikidata (P856).
  3. Bei Kartenzahlungen mit Ort: das Geschäft dieses Namens an diesem Ort in OpenStreetMap. Dessen Marke (`brand:wikidata`) liefert das Wikidata-Logo, sonst dessen eingetragene Webseite (`website`). Nur wenn alle Treffer dieselbe Marke bzw. Webseite haben.
  4. Bei Geschäften aus Kartenzahlungen: `www.<name>.at`, `.de` oder `.com`, aber nur, wenn Titel oder Seitenname der Seite die Marke tragen und die Domain nicht geparkt ist.
- **Vorsicht bei Suchnamen:** Füllwörter („TO“, „ON“, „GmbH“), Regionen und Branchenwörter („Europa“, „Bäckerei“) und Kategorienamen gelten nicht als Marke. Personen und PayPal-Empfänger werden nur mit vollem Namen gesucht. Ein verkürztes einzelnes Wort („Swiss“ aus „Swiss Intl Air Lines“) braucht die Bestätigung der lokalen KI und rät keine Webseite.
- **Drosselung:** Wikidata wird höchstens alle 1,5 s, OpenStreetMap höchstens einmal pro Sekunde gefragt. Meldet ein Dienst 429, wartet der Browser 60 s und macht dann weiter.
- **Icon-Auswahl auf einer Webseite:** `apple-touch-icon`, SVG-Icon, große Icons ab 96 px, `<img>` mit „logo“, `og:image` mit „logo“. Raster unter 64 px werden verworfen. SVGs mit Skripten, eingebetteten Bildern oder externen Verweisen werden abgelehnt.
- **Sicherheit:** Nur HTTPS, keine IP-Adressen oder `localhost`, begrenzte Dateigröße. Alles wird als PNG neu gerendert.
- **Gedächtnis:** Nicht gefundene Händler stehen in `Logo/.logo-misses.json` und werden erst nach 30 Tagen erneut gesucht. Drosselungen merkt er sich nicht, der nächste Lauf macht dort weiter.
- **Erkennung vorhandener Logos:** Gleichnamige Filialen aus dem öffentlichen Katalog (z. B. mehrere „Spar“) blockieren das eigene Logo nicht mehr. Bei mehreren Dateien derselben Marke gewinnt der Markenname (`amazon.png` vor `AMZNPRIME.png`). „Uber Trip“ findet `uber.png` über den Wortanfang.
- **Ordner:** bis zu 1000 Logos. Der Live-Sync liest nur neue oder geänderte Dateien ein.

## MCP-Server

Werkzeuge: `ai_status`, `list_categories`, `finance_summary`, `finance_insights` (Abos, Preisänderungen, doppelte Abbuchungen, Prognose), `list_open_reviews`, `search_transactions`, `categorize_open_reviews` (`apply=false` liefert nur Vorschläge; `apply=true` schlägt vorher unbekannte Geschäfte im Internet nach), `learn_categories_from_web` (Internet-Kategorisierung wie oben), `assign_category`, `find_merchant_logo`, `find_all_merchant_logos` (Logos für alle Zahlungsempfänger ohne Logo, siehe „Händler-Logos“).

Beispielkonfiguration für einen MCP-Client:

```json
{
  "mcpServers": {
    "finanzblick": {
      "command": "npm",
      "args": ["--prefix", "C:\\Users\\<name>\\Documents\\Private\\Finanzdashboard", "run", "--silent", "mcp"]
    }
  }
}
```

Der MCP-Server schreibt direkt in die SQLite-Datenbank. Ein geöffneter Browser lädt den neuen Stand beim nächsten Fokus nach.

### Web-MCP-Server `finanzblick-web`

`npm run mcp:web` startet einen zweiten MCP-Server (stdio) mit öffentlichen Marktdaten für die Sparplanung. Er hat keinen Zugriff auf die Datenbank, nur Lesewerkzeuge:

| Werkzeug | Quelle |
| --- | --- |
| `get_inflation` | Eurostat, HVPI Österreich (`prc_hicp_minr`), Veränderung zum Vorjahresmonat |
| `get_interest_rates` | EZB-Einlagesatz und Ø Zinsen österreichischer Banken für täglich fällige und bis 1 Jahr gebundene Spareinlagen (EZB MIR) |
| `get_exchange_rates` | EZB-Referenzkurse, z. B. `["JPY", "USD"]` |
| `get_market_snapshot` | alles zusammen, Teilausfälle stehen in `errors` |
| `search_knowledge` | deutschsprachige Wikipedia (CC BY-SA 4.0): Erklärung eines Finanzbegriffs mit Titel, Text und Link, `null` ohne passenden Treffer |

Der Finanz-Assistent nutzt denselben Server im Prozess (`src/lib/web/mcp-client.ts`, In-Memory-Transport) über `GET /api/market?currencies=JPY`. Ins Internet gehen nur feste öffentliche Abfragen und Währungscodes, nie Beträge oder Buchungen. Werte werden 6 Stunden zwischengespeichert; fällt eine Quelle aus, bleibt der letzte Wert. `search_knowledge` stellt eine einzige Suchanfrage (Begriffsklärungen, Personen und Fremdthemen werden übersprungen) und merkt sich das Ergebnis eine Woche lang. Eintrag für einen MCP-Client wie oben, mit `"mcp:web"` statt `"mcp"`.

## Lokaler Agent

```powershell
npm run ai:agent -- "Wie viel habe ich im Oktober für Lebensmittel ausgegeben?"
npm run ai:agent            # interaktiv, Ende mit leerer Zeile oder exit
```

Der Agent ändert Daten nur, wenn man es ausdrücklich verlangt. Vor jedem schreibenden Werkzeug fragt er interaktiv nach (`j/n`); im Einmal-Modus braucht es dafür `--yes`, sonst wird die Änderung abgelehnt.

## Schutz vor versteckten Anweisungen

Buchungstexte, Händlernamen und Web-Inhalte (Wikipedia, Wikidata, OSM) gelten als reine Daten. `src/lib/ai/untrusted.ts` entfernt daraus unsichtbare Zeichen, Chat-Template-Tokens und Befehle wie „Ignoriere alle Anweisungen“. Enthält ein Text solche Befehle, werden auch Links, IBANs, E-Mails und Telefonnummern darin entfernt. Alle Prompts enthalten eine Sicherheitsregel. Freie Antworten und Zusammenfassungen werden verworfen, wenn sie Links oder Kontonummern enthalten, die nicht in den Fakten stehen.

## Qualitätsprüfung

```powershell
npm run eval:assistant              # goldene Fragen + Injection-Tests gegen das lokale Modell
npm run eval:assistant -- --min=90  # Mindest-Trefferquote in Prozent
```

Die Fälle stehen in `src/lib/assistant/eval-cases.ts`. `eval-cases.test.ts` prüft in `npm test` zusätzlich, dass die Regeln allein nie ein falsches Werkzeug wählen.
