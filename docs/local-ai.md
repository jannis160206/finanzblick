# Lokale KI (NPU)

Finanzblick kann offene Buchungsprüfungen mit einem lokalen Sprachmodell erledigen. Das Modell läuft auf der Intel-NPU (Core Ultra, „Intel AI Boost“). Es arbeitet vollständig offline: Finanzdaten verlassen den Rechner nicht.

## Komponenten

| Teil | Aufgabe |
| --- | --- |
| OpenVINO Model Server (OVMS) | Stellt `Qwen3-8B-int4-cw-ov` auf der NPU als OpenAI-kompatible API unter `http://127.0.0.1:8000/v3` bereit, dazu `Qwen3-Embedding-0.6B-int8-ov` (CPU) unter `/v3/embeddings` |
| `/api/ai/knowledge` | Durchsucht das lokale Finanzwissen und die vom Nutzer bestätigten Antworten hybrid (Vektor und Stichwort, höchstens drei Treffer); siehe [ASSISTANT-ORCHESTRATOR.md](ASSISTANT-ORCHESTRATOR.md#lokales-finanzwissen-rag) |
| `/api/ai/web-search` | Websuche des Finanz-Assistenten: nur Suchwörter, bis zu drei öffentliche Quellen zum Vergleichen; siehe [ASSISTANT-ORCHESTRATOR.md](ASSISTANT-ORCHESTRATOR.md#freie-formulierungen-websuche-und-selbstlernen) |
| `/api/assistant-feedback` | 👍/👎 mit Kommentar und Kontext in die Feedback-Datei schreiben; Übersicht und Download nur für den Administrator; siehe [ASSISTANT-ORCHESTRATOR.md](ASSISTANT-ORCHESTRATOR.md#feedback-datei-für-copilot) |
| `AiReviewAssistant` (Browser) | Schickt offene Prüfungen in Achterpaketen an `/api/ai/categorize` und übernimmt nur sichere Antworten |
| `/api/ai/logo` | Sucht ein Händlerlogo (Wikidata/Commons, offizielle Webseite, Marken-Domain) und legt es in den privaten `Logo/`-Ordner |
| `/api/ai/logos` | Sucht der Reihe nach Logos für alle Zahlungsempfänger, die noch keines haben (siehe „Händler-Logos“) |
| `/api/ai/web-categories` | Schlägt den Geschäftstyp unbekannter Händler bei OpenStreetMap, Wikidata oder auf der Händler-Webseite nach (braucht kein Modell) |
| `npm run mcp` | MCP-Server (stdio) mit Finanzwerkzeugen für Claude Desktop, VS Code, Copilot oder den lokalen Agenten |
| `npm run ai:agent` | Freier Chat mit dem lokalen Modell, das die MCP-Werkzeuge selbst aufruft |
| `npm run watch:run` | Hintergrund-Agent: prüft einmal und meldet Wichtiges per Windows-Benachrichtigung (siehe unten) |

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
- Das Einbettungsmodell für das lokale Finanzwissen (etwa 600 MB, CPU) lädt `ai-server.ps1` beim nächsten Start nach und trägt es in `config.json` ein. `npm run ai:server -- -EmbeddingModel ""` lässt es weg; die Wissenssuche nutzt dann nur Stichwörter.

Optionale Variablen in `.env.local`:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `FINANZBLICK_AI` | `true` | `false` schaltet die KI ab |
| `FINANZBLICK_AI_URL` | `http://127.0.0.1:8000/v3` | Nur Loopback-Adressen sind erlaubt |
| `FINANZBLICK_AI_MODEL` | `OpenVINO/Qwen3-8B-int4-cw-ov` | Modellname in OVMS |
| `FINANZBLICK_AI_EMBEDDING_MODEL` | `OpenVINO/Qwen3-Embedding-0.6B-int8-ov` | Einbettungsmodell für das lokale Finanzwissen; `off` schaltet es ab (nur Stichwortsuche) |
| `FINANZBLICK_AI_MIN_CONFIDENCE` | `90` | Mindestsicherheit (50–100) für automatische Übernahme |
| `FINANZBLICK_AI_TIMEOUT_MS` | `180000` | Zeitlimit pro Modellanfrage |
| `FINANZBLICK_MCP_USER` | `admin` | Konto, auf das MCP-Server, Agent und Hintergrund-Agent zugreifen |
| `MCP_PSEUDONYMIZE` | `1` | `0` schaltet die Pseudonymisierung im MCP-Server ab |
| `MCP_PRIVATE_NAMES` | – | Zusätzliche Personennamen zum Maskieren, getrennt durch Komma oder Strichpunkt |
| `FINANZBLICK_WATCH_STATE` | `%LOCALAPPDATA%\FinanzblickAI\watch-state.json` | Merkliste des Hintergrund-Agenten |
| `FINANZBLICK_WEB_SEARCH` | an | `off` schaltet die automatische Websuche des Finanz-Assistenten ab |
| `FINANZBLICK_SEARXNG_URL` | – | eigene SearXNG-Instanz (JSON-Format aktiviert) statt Bing, z. B. `http://127.0.0.1:8888` |
| `BRAVE_SEARCH_API_KEY` | – | Brave-Search-API statt Bing, wenn kein SearXNG gesetzt ist |
| `FINANZBLICK_FEEDBACK_FILE` | `data/assistant-feedback.json`, in Produktion neben der Datenbank | Absoluter Pfad der Feedback-Datei des Finanz-Assistenten |

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

- **Orchestrator und Spezialisten:** Ein leichter Orchestrator wählt pro Nachricht genau einen Agenten:
  - Umsätze, Verträge, Budget & Prognose oder Gehalt & Steuern;
  - im Zweifel den allgemeinen Chat.

  Er entscheidet zuerst mit Regeln, dann mit Signalwörtern und nur zuletzt mit einem Ein-Wort-Aufruf des Modells. Jeder Spezialist sieht nur seine eigenen Werkzeuge und Fakten. Pro Nachricht gibt es höchstens zwei KI-Aufrufe. Rechnen und Navigation beantwortet er ohne Modell. Fachfremde Themen (Filme, Bücher, Wetter, Rezepte, Allgemeinwissen, Witze, Datum und Uhrzeit) lehnt er ebenfalls ohne Modell freundlich ab (`src/lib/assistant/scope.ts`). Kombinierte Fragen teilt er in Teilfragen. Die versteckte Ansicht **Einstellungen → „Assistent-Orchestrator“** zeigt Aufbau, Agenten, letzte Läufe mit Weg und Dauer sowie die Werkzeuge. Details: [ASSISTANT-ORCHESTRATOR.md](ASSISTANT-ORCHESTRATOR.md).
- **Nur Extraktion:** `/api/ai/assistant` (`src/lib/ai/assistant.ts`) lässt das Modell aus dem Freitext nur Absicht und Angaben herauslesen (Ziel, Betrag, Datum, Konto, Startkapital, Raten). Jede Angabe muss im Text vorkommen (`groundModelExtraction`), sonst wird sie verworfen. Ohne KI oder bei Fehlern übernimmt der Regel-Parser (`src/lib/assistant/intent.ts`). Fehlt eine Angabe, fragt der Assistent nach.
- **Konten, Amex, Monatsplan:** Kontostände, die Amex-Abrechnung (offener Saldo minus Rückzahlungs-Pocket, gleiche Rechnung wie im Dashboard) und der Monatsplan kommen direkt aus `calculateDashboard` (`src/lib/assistant/accounts.ts`). Ausgabenfragen verstehen Zeiträume wie „seit 11.10.“ und Konten wie „mit Amex“.
- **Folgefragen und Vergleich:** Kurze Nachfragen wie „und im September?“, „und mit Amex?“ oder „warum so viel?“ übernehmen Kategorie, Händler, Konto und Monat der vorherigen Frage (`src/lib/assistant/followup.ts`, ohne Modellaufruf). „Vergleich Oktober mit September“ oder „Mehr als im Vormonat?“ stellt zwei Monate gegenüber und nennt die größte Veränderung.
- **Ausgabenverlauf:** „Wie haben sich meine Ausgaben entwickelt?“ zeigt die letzten 6 vollen Monate (oder „letzte N Monate“) mit Abweichung zum Schnitt, dem teuersten und günstigsten Monat. Kategorie, Händler und Konto gelten auch für Nachfragen wie „und fürs Essen?“.
- **Finanz-Check:** „Bin ich sparsam?“ oder „Wie stehe ich finanziell da?“ bewertet die letzten drei vollen Monate als Ampel (`src/lib/assistant/check.ts`): Sparquote (Ziel ≥ 20 %), Fixkosten-Anteil (≤ 50 %), Reserve in Monatsausgaben (≥ 3), Ausgaben des letzten Monats gegenüber den zwei davor, Abos und offene Amex-Rückzahlung. Einkommen kommt aus dem Monatsplan, Rückerstattungen mindern die Ausgaben.
- **Bedienung:** Mit Pfeil-hoch im leeren Eingabefeld holst du die letzte eigene Nachricht zurück.
- **Freie Fragen:** Passt kein Werkzeug, beantwortet `/api/ai/answer` die Frage mit der Stimme des gewählten Agenten (`agent`) und nur aus dessen Ausschnitt der fertig gerechneten Fakten (`src/lib/assistant/specialist-context.ts`). Jede Zahl muss dort stehen (`numbersBacked`). Nur der allgemeine Chat ohne persönliche Fakten darf allgemeines Finanzwissen mit Zahlen nennen (z. B. „3 bis 6 Monatsausgaben als Notgroschen“); Geldbeträge, Links und Kontonummern müssen auch dort belegt sein.
- **Feste Rechnung:** `src/lib/assistant/plan.ts` rechnet mit dem Monatsplan: Monatsrate bzw. erreichbares Datum für Sparziele, Konflikte mit bestehenden Zielen, Monate ohne volle Rate.
- **„Kann ich mir das leisten?“:** Ampel aus dem frei verfügbaren Betrag über dem Sparsockel. 🟢 reicht, 🟡 nur mit ausgesetzter Sparrate, 🔴 Fehlbetrag mit Alternativen (Raten, späterer Monat, Rücklage vom Sparkonto).
- **Nichts automatisch:** Gespeichert wird erst bei „Anlegen“. „Ändern“ öffnet ein Formular, „Was-wäre-wenn“-Fragen werden nur berechnet.
- **Verlauf:** `appState.assistantChat` (max. 100 Nachrichten) in der lokalen Datenbank, nicht im Excel-Backup.

### Agent

Die KI wählt nur ein Werkzeug (`src/lib/assistant/tools.ts`) und nennt Namen aus dem mitgeschickten Kontext (Ziel-, Ausgaben-, Kategorie- und Händlernamen). Namen, die weder im Kontext noch im Text vorkommen, werden verworfen. Klare Befehle („rückgängig“, „merk dir“, „ist immer“) erkennt der Regel-Router auch ohne Modell. Ausgeführt wird alles in `src/lib/assistant/agent.ts`.

- **Fragen zu den Daten** (`answers.ts`): Summe, Aufteilung, größte Ausgabe, Einnahmen, Abos, Anzahl, Durchschnitt für Monat, Woche, „letzte N Monate“ oder Jahr. Unter der Antwort lassen sich die zugrunde liegenden Buchungen aufklappen.
- **Bestehendes ändern:** Sparziele (Betrag, Datum, Rate, Name, Rate in Monaten aussetzen, Extra-Beträge, erreicht, löschen), geplante Ausgaben (verschieben, Betrag, Raten, umbenennen, löschen, „Zahl das Pickerl vom Sparkonto“, „Teil das Pickerl mit Raphael“), Notgroschen-, Urlaubs- und Sparkonto-Ziel. Erlaubt sind nur die Operationen aus `assistantOperationSchema`.
- **Buchungen bearbeiten:** „Benenne BILLA DANKT in Billa um“ (Anzeigename), „Nimm die Buchung vom 3.11. aus dem Plan“, „Netflix ist Fixkosten“, „Markier alle Billa-Buchungen als geprüft“, „Teil die Buchung vom 20.10. mit Raphael“. Auswahl über Händler, Datum („vom 3.11.“), Betrag („die 12,99 €“) oder Zeitraum; die Karte listet die betroffenen Buchungen. Operation `transaction_update`, rückgängig machbar (`src/lib/assistant/bookings.ts`). Wie in den Umsätzen lässt sich eine geteilte Buchung nicht wieder auf ungeteilt stellen.
- **Buchungen löschen und taggen** (`booking-actions.ts`): „Lösch die Buchung vom 24.8. über 249 €“ löscht genau eine benannte Buchung (bei mehreren Treffern fragt er nach, höchstens 10 auf einmal, „alle löschen“ nie); „Tagge die Buchungen vom 10. bis 12.8. mit Malaga“ und „Entferne den Tag Malaga“ setzen und entfernen Tags. Operationen `transaction_delete` und `transaction_tag`; Rückgängig stellt gelöschte Buchungen samt Fixkosten-Zuordnung wieder her.
- **Verträge** (`contract-draft.ts`, `contract-actions.ts`): „Leg einen neuen Vertrag an“ fragt in der Reihenfolge des Vertragsdialogs nach Name, Betrag, Kategorie, Kündigungsfrist, Mindestlaufzeit, Rhythmus, nächster Abbuchung und – nur wenn passende Buchungen existieren – der automatischen Zuordnung; was schon im Satz steht, überspringt er. Danach kommt die Vorschau, gespeichert wird mit „Bestätigen“ oder „Ja“. Vorschläge zu jedem Schritt erscheinen als Antwort-Knöpfe, „Abbrechen“ verwirft den Entwurf, eine Zwischenfrage wird normal beantwortet. „Netflix kostet jetzt 15,99 €“, „Kündigungsfrist von Magenta ist 3 Monate“, „Bestätige Spotify“, „Blende FITINN aus“ oder „Netflix ist gekündigt zum 31.12.“ ändern bestehende Verträge (`contract_create`, `contract_update`, `contract_action`).
- **Monatsplan** (`plan-rows.ts`): „Füg eine Position Fitnessstudio hinzu“, „Benenne die Position Geschenke in Weihnachten um“, „Lösch die Position Strom“, „Setz die Miete im Dezember auf 700 €“, „Tanken ab Jänner auf 120 €“ und „… wieder auf automatisch“ wirken wie die Bearbeitung der Monatstabelle (`plan_row_save`, `plan_row_delete`, `plan_value`).
- **Kontoregeln und Successbonus:** „Sparkonto ist für alle Ausgaben“, „Lösch die Kontoregel für Sparkonto“ und „Setz den Successbonus auf 15 %“ kommen wie jede andere Änderung als Vorschau (`account_rule`, `account_rule_delete`, `bonus_percent`).
- **Nur in der App:** Bank- und Google-Anmeldung, Datei-Uploads, Benachrichtigungen, Erscheinungsbild und Backups öffnet der Assistent als Link zur Seite. Buchungen von Hand anlegen gibt es in der App nicht, deshalb auch nicht im Chat.
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
  - *Feedback:* 👍 unter einer Antwort merkt sich die Formulierung für das gewählte Werkzeug. 👎 vergisst sie, notiert die Frage als offen und öffnet ein Kommentarfeld. Eine anders formulierte Frage direkt danach (oder „Nein, ich meinte …“) lernt die ursprüngliche Formulierung für das richtige Werkzeug. Jede Bewertung landet mit Kontext in der [Feedback-Datei](ASSISTANT-ORCHESTRATOR.md#feedback-datei-für-copilot).
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

### Kündigungshilfe

Werkzeug `cancel` (`src/lib/assistant/cancel.ts`): „Kündige Netflix“, „Hilf mir den Handyvertrag zu kündigen“, „Welche Verträge kann ich kündigen?“.

- Verträge stammen aus den erkannten Abos (`detectSubscriptions`, Miete ausgenommen). Die Liste ist nach Jahreskosten sortiert.
- Die Karte zu einem Vertrag zeigt:
  - Kosten pro Monat und pro Jahr
  - die letzte Abbuchung
  - die Preisentwicklung
  - eine allgemeine Kündigungsinfo je Vertragsart, bewusst mit „meist“ formuliert. Beispiele: Handy/Internet meist 1 Monat nach Mindestvertragsdauer, Versicherung zum Ende der Versicherungsperiode (§ 8 VersVG), Streaming monatlich, Fitnessstudio laut Vertrag.
- Links: die Kündigungsseite bekannter Anbieter (Netflix, Spotify, Disney+, Amazon Prime, Apple, Magenta, A1, Drei, HoT, spusu) oder ein Vergleichsportal (durchblicker.at, tarife.at, E-Control-Tarifkalkulator). Es gibt kein Live-Preis-Scraping, und es werden keine Daten gesendet.
- Das Kündigungsschreiben ist formell und hat Platzhalter für Name, Adresse, Kundennummer und Datum. Es lässt sich kopieren oder per `mailto:` öffnen.
- Der Vorschlag „Erinner mich am …, X zu kündigen“ legt über das Werkzeug `reminder` eine Erinnerung an. Das passiert wie immer nur nach deiner Bestätigung.
- Das ist keine Rechtsberatung: Maßgeblich sind der Vertrag und die AGB.

### Warum diese Kategorie?

`explainCategory(state, booking)` (`src/lib/category-why.ts`) erklärt die Zuordnung einer Buchung aus den Feldern, die der Import ohnehin speichert. Ein neues Feld war dafür nicht nötig. Die Reihenfolge entspricht dem Vorrang im Import:

1. **Lokale KI** (`aiAssigned`, mit Begründung aus `aiSuggestions`)
2. **Manuell gesetzt** (`manualCategory` bzw. eine frühere Einzelwahl)
3. **Von dir gelernt** (eine passende `merchantRules`-Regel)
4. Automatische Belege aus dem Import (`automaticCategoryEvidence`):
   - Händlerregel „X → Y“
   - eindeutiger Buchungstext
   - MCC
   - frühere Buchungen
   - Bank-Kategorie
5. **Aus dem Web** (`webCategories`, z. B. OpenStreetMap: supermarket)
6. Vorschläge in `aiSuggestions`
7. Eingebaute Standardregel (`classify`), gegebenenfalls mit der Bank-Kategorie

In der Umsatzliste zeigt das Info-Popover jeder Kategorie den Abschnitt „Warum diese Kategorie?“ mit Kategorie, Quelle, Datum und dem Knopf „Falsch? Kategorie ändern“, der den Bearbeiten-Dialog öffnet. Im Chat beantwortet das Werkzeug `why` (`src/lib/assistant/why.ts`) die Frage „Warum ist Billa Lebensmittel?“ für die letzte Buchung des Händlers und zählt, wie viele Buchungen gleich zugeordnet sind.

### Steuer-Mappe

`taxFolder(state, year)` (`src/lib/tax-folder.ts`) sammelt mögliche absetzbare Ausgaben eines Jahres für die Arbeitnehmerveranlagung, gruppiert nach den Kennzahlen des Formulars L1. Pro Gruppe zeigt sie Summe, Anzahl der Belege und Beleg-Hinweise, etwa „Rechnung im Online-Konto herunterladen“ oder „über 1.000 € abschreiben“. Das Werkzeug `tax` („Steuer-Mappe 2026“, „Was kann ich absetzen?“) zeigt sie als Karte. Auf der Seite „Gehalt & Steuern“ steht sie als Abschnitt „Steuer-Mappe“. Beide bieten den Export als CSV (Excel, `;`, Schutz gegen Formel-Injection) und eine Druckansicht (HTML ohne Skripte).

| Gruppe | Kennzahl | Stand |
| --- | --- | --- |
| Gewerkschaft & Berufsverband | KZ 717 | geläufig |
| Arbeitsmittel | KZ 719 | geläufig |
| Fachliteratur | KZ 720 | geläufig |
| Reisekosten | KZ 721 | geläufig |
| Aus- und Fortbildung | KZ 722 | geläufig |
| Sonstige Werbungskosten | KZ 724 | geläufig |
| Home-Office-Mobiliar | KZ 158 | „bitte prüfen“ |
| Steuerberatung | KZ 460 | „bitte prüfen“ |
| Krankheitskosten (außergew. Belastung) | KZ 730 | „bitte prüfen“ |
| Spenden, Kirchenbeitrag | – | automatisch übermittelt |

Die BMF-Seiten nennen die Kennzahlen selbst nicht, und das Formular-PDF war beim Bau nicht abrufbar. Unsichere Kennzahlen stehen deshalb in der App mit „(bitte prüfen)“. Grundlagen:

- [Werbungskosten](https://www.bmf.gv.at/themen/steuern/arbeitnehmerveranlagung/was-kann-ich-geltend-machen/werbungskosten.html)
- [ABC der Werbungskosten](https://www.bmf.gv.at/themen/steuern/arbeitnehmerveranlagung/was-kann-ich-geltend-machen/werbungskosten/abc-der-werbungskosten.html)
- [Home-Office-Pauschale](https://www.bmf.gv.at/themen/steuern/arbeitnehmerveranlagung/was-kann-ich-geltend-machen/werbungskosten/home-office-pauschale.html)
- [Sonderausgaben](https://www.bmf.gv.at/themen/steuern/arbeitnehmerveranlagung/was-kann-ich-geltend-machen/sonderausgaben.html)
- [Außergewöhnliche Belastungen](https://www.bmf.gv.at/themen/steuern/arbeitnehmerveranlagung/was-kann-ich-geltend-machen/aussergewoehnliche-belastungen.html)

Pendlerpauschale, Familienbonus und Homeoffice-Pauschale stehen nicht in den Umsätzen und fehlen deshalb in der Mappe. Ohne Gewähr, keine Steuerberatung.

### Kontoprognose

Das Werkzeug `forecast` („Wird mein Konto knapp?“, „Reicht mein Geld bis Jänner?“, „Kontoprognose“) rechnet die nächsten 12 Monate Tag für Tag je Konto durch (`src/lib/assistant/forecast.ts`, reine Funktion `projectAccounts`):

- **Girokonto:** Start ist der gemerkte Stand („Merk dir: Girokonto 1.500 €“) plus Revolut-Stand und das Amex-Rückzahlungs-Pocket.
- **Buchungen in der Prognose:**
  - Gehalt am Gehaltstag (gemerkt oder erkannt);
  - Fixkosten an ihrem üblichen Abbuchungstag;
  - Abos, die nicht schon in den Fixkosten stecken;
  - die monatliche Amex-Abbuchung (offener Betrag, danach der übliche Amex-Anteil am Monatsplan);
  - geplante Ausgaben;
  - Sparraten und Alltagsausgaben (Plan-Rest, gleichmäßig verteilt).
- **Sparkonto:** wird mit seinen Sparraten und Entnahmen fortgeschrieben.
- **Schwelle:** Knapp heißt „unter dem gemerkten Puffer“ (ohne Puffer: unter 0 €).
- **Antwort:**
  - Sie nennt den ersten Tiefpunkt mit Ursache, z. B. „Am 15. November wird dein Girokonto knapp (−787,41 €), weil die Amex abgebucht wird.“
  - Die Karte zeigt kritische Tage und ein Liniendiagramm mit dem Monatstiefststand je Konto.
- **Wochenüberblick:** Liegt ein Tiefpunkt in den nächsten 30 Tagen, erwähnt ihn auch der Wochenüberblick.

### Was wäre wenn

Das Werkzeug `whatif` („Wenn ich Netflix kündige und 200 € mehr spare, wann erreiche ich Japan?“, „Was wäre, wenn ich 100 € mehr spare?“) ändert nichts an den Daten.

- **Erkennung:**
  - Abos aus den erkannten Abbuchungen und Fixkosten;
  - Betrag pro Monat;
  - Sparziel per Name, sonst das nächste offene Ziel.
- **Karte:** Sie hat einen Schieberegler „Mehr sparen pro Monat“ und Häkchen je Abo. `computeWhatIf` (`src/lib/assistant/whatif.ts`) rechnet im Browser bei jeder Bewegung neu: frei pro Monat und Jahr, neuer Zielmonat statt bisher, Monate früher.
- **Basis:** Grundlage sind die geplanten Sparraten aus dem Monatsplan bis zum Zieldatum, danach die feste Rate.
- **„Als Sparrate übernehmen“:** Den Knopf gibt es bei Zielen mit fester Rate. Er erzeugt eine normale Änderungs-Vorschau (`goal_update`), die du bestätigen musst.

### Diagramme im Chat

Karten können ein optionales `chart` tragen: Balken oder Linie, höchstens 3 Reihen zu je 24 Punkten, optional eine Schwellenlinie. Das Format steht in `assistantChartSchema`, gebaut wird es mit `buildChart` in `src/lib/assistant/chart.ts`. Gezeichnet wird es als SVG mit den Theme-Farben (`src/components/assistant-chart.tsx`), mit `aria-label` und der aufklappbaren Tabelle „Werte als Tabelle“.

Diagramme haben:

- Monatsvergleich (je Kategorie);
- Ausgaben-Verlauf (mit Durchschnitt);
- Jahresrückblick (Ausgaben je Monat);
- Depot-Rechner (eingezahlt, 3 %, 7 %);
- Kontoprognose.

Alle Werte rechnet der Code, nie das Modell.

### Geschwindigkeit

- **Spezialisten-Prompts:** Statt eines großen Router-Prompts mit allen Werkzeugen sieht das Modell nur die Werkzeuge, Felder und Beispiele des zuständigen Spezialisten. Die Kategorienliste bekommt nur Umsätze, Ziel- und Ausgabennamen nur Budget, der Verlauf ist auf zwei Zeilen begrenzt. Das halbiert die Dauer einer Interpretation (Median 8,3 s → 4,0 s). Die statischen Prompts bleiben im Präfix-Cache des Modellservers.
- **Schnellweg ohne Modell:** Erkennt der Regel-Router einen klaren Befehl und braucht das Werkzeug keine Modell-Hinweise, antwortet `/api/ai/assistant` sofort ohne NPU-Aufruf (Quelle „Regel“). Das Modell wird nur noch gefragt bei offenem Entwurf, bei Entwürfen (Sparziel, Ausgabe, „Kann ich mir das leisten?“), bei Werkzeugen mit Hinweisen (`hintTools` in `src/lib/ai/assistant.ts`: Datenfragen, Ändern, Buchungen, Regeln) und wenn keine Regel greift.
- **Kleines Router-Modell (optional):** `FINANZBLICK_AI_ROUTER_MODEL` (oder `AI_ROUTER_MODEL`), z. B. `OpenVINO/Qwen3-1.7B-int4-ov`, wählt nur das Werkzeug; freie Antworten schreibt weiter das 8B-Modell. Antwortet es nicht oder ohne gültiges JSON, übernimmt das Hauptmodell. Laden mit `npm run ai:server -- -RouterModel OpenVINO/Qwen3-1.7B-int4-ov` (zieht das Modell und trägt es zusätzlich in `models\config.json` ein). `/api/ai/status` meldet dann `router.available`.
- **Streaming:** `/api/ai/answer?stream=1` liefert die freie Antwort als NDJSON (`{"delta": "…"}` … `{"done": true, "ok": true, "text": "…"}`); der Chat zeigt sie Wort für Wort. Gezeigt werden nur ganze Wörter, solange alle Zahlen und Kontakte belegt sind, und nichts, solange die Antwort wie JSON aussieht. Am Ende wird der ganze Text wie bisher geprüft (`numbersBacked`, `contactsBacked`); fällt er durch, verschwindet die Blase und es kommt die übliche Rückfrage. Ohne `stream=1` bleibt die JSON-Antwort unverändert.

## PDF-Kontoauszüge

Ein PDF-Auszug einer beliebigen Bank kann wie CSV oder Screenshot einfach in den Import gezogen werden. Amex-PDFs laufen weiter über den eigenen Parser; alle anderen gehen an `src/lib/import/generic-pdf.ts`.

- **Ohne KI zuerst:** Der Text der Seiten wird zeilenweise gelesen: Datum (auch ohne Jahr, mit Valuta, „1 Sep 2026“), Buchungstext und Betrag am Zeilenende. Unterstützt werden `-1.234,56`, `1.234,56-`, `S`/`H`, `EUR`/`€`, eine Saldospalte und umbrochene Texte. Die Bank wird aus dem Text erkannt (Erste/George, Raiffeisen, BAWAG, Bank Austria, N26, Revolut, DKB, Volksbank; sonst „PDF-Import“).
- **Saldenprüfung:** Steht ein Anfangs- und Endsaldo im Auszug (z. B. „Alter/Neuer Kontostand“, „Saldovortrag“, „Opening/Closing balance“), muss Anfangssaldo + Buchungen den Endsaldo ergeben. Fehlt das Vorzeichen, wird es aus der Saldospalte abgeleitet. Ist es danach noch unklar, landet die Buchung in der Prüfung.
- **KI nur bei Bedarf:** Bleiben Zeilen unlesbar oder geht der Saldo nicht auf, liest die lokale KI den Auszug in Abschnitten von etwa 3200 Zeichen (`src/lib/ai/pdf-ai.ts`, Temperatur 0, `DATA_RULE`, Text durch `cleanUntrusted`).
  - Die KI extrahiert nur. Jede Zeile wird per Code geprüft: Datum im Zeitraum (±3 Tage) und im Text abgedruckt, Betrag genau so im Text, Buchungstext mit Wörtern aus dem Auszug. Das Vorzeichen kommt aus `-`/`S`/`Soll` bzw. `+`/`H`/`Haben` im Text.
  - KI-Buchungen werden nie direkt gespeichert. Sie erscheinen als „Mit KI-Hilfe aus PDF gelesen“ in „Buchungen korrigieren“.
- **Zeitlimit:** Für PDFs hat der Hintergrund-Parser 10 statt 2 Minuten. Ein neuer KI-Abschnitt startet nur, wenn noch 45 Sekunden übrig sind; sonst meldet der Import, wie viele Abschnitte gelesen wurden. Im Browser-Pfad ohne Konto läuft nur der Teil ohne KI.
- **Status:** Der Uploadstatus zeigt „PDF erkannt: 23 Buchungen, 2 bitte prüfen“. Gescannte PDFs ohne Text werden gemeldet (dann CSV oder Screenshots verwenden).

## Kassenbon aufteilen

Eine Ausgabe (z. B. BILLA −54,30 €) kann nach dem Kassenbon auf mehrere Kategorien verteilt werden: Buchung → Menü → „Kassenbon aufteilen“.

- **Einlesen:** Foto (OCR mit tesseract.js im Browser, Deutsch + Englisch, lokale Sprachdaten) oder Text-PDF. `src/lib/receipts/receipt.ts` erkennt Artikel, „2 x 1,99“, Gewichtszeilen, Rabatt/Aktion (wird vom Artikel davor abgezogen), Pfand/Leergut und „SUMME“.
- **Kategorien:** Eine Stichwortliste ordnet Artikel zu, z. B. Lebensmittel, Drogerie, Haushalt, Haustiere, Gesundheit. Alkohol zählt zu Lebensmitteln mit Vermerk „Alkohol“, Tabak zu Shopping. Unbekannte Artikel bekommen die Kategorie der Buchung und sind als „unsicher“ markiert. Auf Wunsch schlägt die lokale KI Kategorien dafür vor (`/api/ai/receipt-items`, nur Artikelnamen, nur erlaubte Kategorien). Jede Kategorie lässt sich vor dem Speichern ändern.
- **Betrag stimmt immer:** Die Kategoriesummen werden cent-genau auf den Buchungsbetrag skaliert (größter Rest). Weicht die Bonsumme vom Buchungsbetrag ab (Pfandrückgabe, Trinkgeld, OCR-Fehler), zeigt der Dialog den Unterschied.
- **Gespeichert** wird `splits: [{category, amount, note?}]` an der Buchung (2–20 Teile, gleiches Vorzeichen, Summe = Betrag). Ausgaben je Kategorie im Dashboard, Monatsrückblick und `finance_summary` rechnen mit den Teilen (`categoryParts` in `src/lib/splits.ts`). „Aufteilung entfernen“ macht es rückgängig.

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

### Pseudonymisierung

Bevor Daten über `npm run mcp` an Claude, ChatGPT oder Copilot gehen, ersetzt `src/lib/ai/pseudonymize.ts` private Angaben durch Platzhalter:

| Angabe | Platzhalter |
| --- | --- |
| Personen (Empfänger und Auftraggeber von Überweisungen wie „To …“, „Überweisung an …“, „Auftraggeber: …“, zweite Karteninhaber, `MCP_PRIVATE_NAMES`) | `Person-1`, `Person-2`, … |
| IBANs | `IBAN-1`, … |
| E-Mail-Adressen und Telefonnummern | `email-1`, `Telefon-1`, … |
| Karten- und lange Kontonummern | `Karte-1`, `Nummer-1`, … |

Händler- und Firmennamen, Kategorien, Beträge und Datumsangaben bleiben lesbar, damit Auswertungen sinnvoll bleiben. Vor- und Nachname derselben Person bekommen denselben Platzhalter. Innerhalb einer Sitzung sind die Platzhalter stabil: Nennt das externe Modell in einem Werkzeugaufruf `Person-1` oder `IBAN-2`, setzt der Server vor dem Ausführen wieder den echten Wert ein. Werkzeugbeschreibungen und Server-Hinweise sagen dem Modell, dass Namen pseudonymisiert sind. Neue Namen lernt der Server nach, sobald sich die Daten ändern.

Ausschalten mit `MCP_PSEUDONYMIZE=0` (z. B. in `.env.local`). Der Finanz-Assistent im Browser und `npm run ai:agent` arbeiten mit dem lokalen Modell und sehen die echten Daten. Der Web-MCP-Server bekommt ohnehin keine persönlichen Daten.

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

## Hintergrund-Agent

`scripts/watch.ts` liest die lokalen Finanzdaten (wie der MCP-Server, Konto aus `FINANZBLICK_MCP_USER`) und sucht mit `src/lib/assistant/watch.ts` nach Wichtigem:

- Erinnerungen, die in den nächsten 3 Tagen fällig oder überfällig sind
- doppelte Abbuchungen der letzten 14 Tage
- Monat geht sich nicht aus oder fällt unter deinen Puffer
- Amex-Rückzahlung ist nicht gedeckt
- neue, ungewöhnlich hohe Ausgaben seit dem letzten Lauf (ab 400 € oder dreimal so viel wie sonst in der Kategorie, keine bekannten wiederkehrenden Beträge)
- Preiserhöhungen von Abos und Jahresabos, die sich in den nächsten 14 Tagen verlängern

Nur wenn es etwas Neues gibt, erscheint eine Windows-Benachrichtigung „Finanzblick“ mit höchstens drei Zeilen. Ein Klick öffnet den Finanz-Assistenten (`http://127.0.0.1:3000/assistent`, anpassbar mit `FINANZBLICK_URL`). Bereits gemeldete Hinweise merkt sich der Agent 180 Tage lang in `%LOCALAPPDATA%\FinanzblickAI\watch-state.json` (außerhalb des Repos, nur Hashwerte und Buchungs-IDs). Der erste Lauf merkt sich die vorhandenen Buchungen; ungewöhnliche Buchungen meldet er erst ab dem zweiten Lauf.

```powershell
npm run watch:run -- --dry-run   # nur anzeigen, keine Benachrichtigung, nichts merken
npm run watch:run -- --counts    # nur Anzahl je Art, ohne Namen und Beträge
npm run watch:run -- --test      # eine Testbenachrichtigung
npm run watch:run                # echter Lauf
npm run watch:run -- --ai        # erste Zeile formuliert die lokale KI (Zahlen werden gegen die Hinweise geprüft)
npm run watch:install            # Windows-Aufgabe „Finanzblick Hintergrund-Agent“: täglich 07:30 und bei der Anmeldung
npm run watch:uninstall          # Aufgabe wieder entfernen
```

Die geplante Aufgabe läuft ohne Adminrechte unter deinem Benutzer und nur, wenn du angemeldet bist. Ist der PC um 07:30 aus, holt Windows den Lauf nach. Jeder Lauf schreibt eine Zeile nach `%LOCALAPPDATA%\FinanzblickAI\watch.log`. Eine andere Uhrzeit: `powershell -File scripts/watch-task.ps1 -Install -At 21:00`.

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

Die Fälle stehen in `src/lib/assistant/eval-cases.ts`, die grenzwertigen Orchestrator-Fälle in `agentCases`. Die Ausgabe nennt je Frage Agent, Weg (Regel, Signal, Modell, Rückfall), Zahl der KI-Aufrufe und Dauer. `eval-cases.test.ts` prüft in `npm test` zusätzlich, dass die Regeln allein nie ein falsches Werkzeug oder einen falschen Spezialisten wählen.
