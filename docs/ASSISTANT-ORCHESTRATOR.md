# Finanz-Assistent: Orchestrator und Spezialisten

Stand: 11.11.2026

## Ausgangslage (vorher)

- **Ein Router für alles:** `/api/ai/assistant` schickte jede unklare Nachricht mit einem großen Prompt (48 Werkzeuge, rund 60 Beispiele, alle Kategorien, sechs Verlaufszeilen) an das Modell. Bei einem Fehler des Router-Modells folgte ein zweiter Aufruf mit dem Hauptmodell.
- **Eine Stimme für alles:** Freie Antworten bekamen immer alle Fakten (mit echten Daten rund 6.300 Zeichen), auch für Smalltalk oder Wissensfragen.
- **Bis zu drei KI-Aufrufe pro Nachricht:** Router-Modell, Hauptmodell, freie Antwort.
- **Gemessen mit Qwen3-8B auf der NPU** (`npm run eval:assistant`):
  - 97 von 98 goldenen Fragen richtig;
  - Modellaufrufe des Routers dauerten 5–11 s (Median 8,3 s, Ausreißer 23 s).

## Architektur

Orchestrator-Worker-Muster ohne Framework, im bestehenden TypeScript-Code. Der Orchestrator entscheidet einmal und übergibt an genau einen Agenten. Es gibt keine verschachtelten Übergaben.

| Agent | Zuständig für | Werkzeuge (je genau ein Eigentümer) |
|---|---|---|
| **Umsätze** | vergangene Buchungen, Ausgaben und Einnahmen, Händler, Kategorien, Monats- und Jahresrückblick, Doppel- und verdächtige Buchungen, Rückerstattungen, offene Bestellungen, geteilte Kosten | `query`, `booking`, `rule`, `cleanup`, `why`, `security`, `refunds`, `context`, `orders`, `shared`, `month_review`, `review` |
| **Verträge** | Abos und Verträge, Kosten, Laufzeit, Fristen, Kündigen | `contracts`, `cancel` |
| **Budget & Prognose** | Monatsplan, Kontostände, Prognose, Sparziele, geplante Ausgaben, „Geht sich das aus?“, Spartipps, Anlegen, Kredite | `budget`, `budget_plan`, `pulse`, `forecast`, `funds`, `account_rule`, Entwürfe (`savings_goal`, `expense`, `affordability`), `edit`, `batch`, `whatif`, `coach`, `check`, `briefing`, `insights`, `accounts`, `amex`, `networth`, `depot`, `loan` |
| **Gehalt & Steuern** | Lohnabrechnung, netto und brutto, Sonderzahlungen samt Anteil zu 6 % und voll versteuert, Jahressechstel, Arbeitnehmerveranlagung | `payroll` (neu), `tax`, `homeoffice` |
| **Allgemeiner Chat** (kein Spezialist, Rückfallebene) | Plaudern, allgemeine Fragen, Begriffe, Bedienung, Marktdaten, Gedächtnis; alles Unklare | `help`, `explain`, `knowledge`, `market`, `memory`, `remember`, `forget`, `changes`, `undo`, `reminder`, `ask` |

**Annahme:** Die Vorgabe „strikt maximal 4 Spezialisten“ nennt fünf Bereiche. Der allgemeine Chat ist deshalb kein Spezialist, sondern die Rückfallebene des Orchestrators. So bleibt es bei vier Spezialisten.

**Dateien**

- `src/lib/assistant/orchestrator.ts`: Agenten, Werkzeug-Eigentümer, Signalwörter, `routeByRules`, `parseAgent`.
- `src/lib/ai/specialists.ts`: Orchestrator-Prompt (ein Wort), Werkzeug-Prompt je Spezialist und Stimme je Agent.
- `src/lib/ai/assistant.ts`: Ablauf auf dem Server.
- `src/lib/assistant/specialist-context.ts`: Fakten-Ausschnitt und Kontext-Werkzeug je Agent.
- `src/lib/assistant/payroll.ts`: neues Werkzeug für Gehalt & Steuern.
- `src/lib/assistant/fixed-replies.ts`: feste Antworten ohne Modell (Navigation, Farbschema, Rechnen, Wetter, „Mein Konto ist leer“) und Rückfragen auf einzelne Wörter.
- `src/lib/assistant/combined.ts`: teilt kombinierte Fragen in Teilfragen mit je eigenem Werkzeug.

## Ablauf und KI-Aufrufe

1. **Regeln (0 Aufrufe):**
   - Smalltalk und kreative Bitten („Schreib mir ein Gedicht …“) gehen an den Chat.
   - Feste Antworten ohne Modell: Datum und Uhrzeit, Rechnen („15 % von 2400“), Witze, Wetter, Navigation („Öffne die Verträge“), Farbschema, „Mein Konto ist leer“, „Lösche alle Buchungen“.
   - Kombinierte Fragen („Wie hoch ist mein Gehalt und wann kommt es?“) werden in Teile zerlegt; jeder Teil bekommt sein eigenes Werkzeug, höchstens ein Teil eine freie Antwort.
   - Faktenfragen („Wie hoch ist der Großglockner?“, „Hauptstadt von Australien“, „Wie mache ich Kaiserschmarrn?“) schlagen den Gegenstand in der Wikipedia nach. Das Modell liest die Antwort in einem Satz aus dem Artikel; findet sich nichts, antwortet es knapp bei Temperatur 0,1.
   - Klare Befehle bestimmen das Werkzeug und damit den Eigentümer.
   - Folgefragen und gelernte Formulierungen werden wie bisher ohne Modell erkannt.
2. **Signalwörter (0 Aufrufe):** Trifft die Nachricht die Wörter genau eines Spezialisten (z. B. „Sparkonto“, „Netto“, „Abo“), übernimmt dieser. Ohne jeden Geldbezug antwortet sofort der allgemeine Chat.
3. **Modell-Rückfall (1 kurzer Aufruf):** Nur wenn dann noch unklar ist, wer zuständig ist.
   - Das Modell antwortet mit einem Wort: `umsaetze`, `vertraege`, `budget`, `gehalt` oder `chat`.
   - Höchstens 8 Token, mit kleinen Beispielen im statischen Prompt.
   - Unsicher, mehrere Namen, Fehler oder keine KI: allgemeiner Chat.
4. **Spezialist:**
   - Mit Werkzeug rechnet der Code; das Modell ist nur nötig, wenn Werkzeug-Hinweise oder ein Entwurf gelesen werden müssen.
   - Dieser Aufruf sieht nur die eigenen Werkzeuge, Felder und Beispiele.
   - Nach einer Modell-Weiterleitung antwortet der Spezialist direkt in Worten, ohne zweite Interpretation.
5. **Antwort (höchstens 1 Aufruf, gestreamt):** Nur für Fragen, die eine Erklärung brauchen, oder ohne passendes Werkzeug. Der Agent bekommt seine Stimme, nur seine Fakten und das Ergebnis seines Kontext-Werkzeugs:
   - Umsätze: Monatsbericht;
   - Verträge: Vertragsliste;
   - Budget: Monats-Puls;
   - Gehalt: Gehaltsübersicht.

**Damit:** höchstens ein Modellaufruf für die Interpretation und höchstens zwei pro Nachricht insgesamt. Klare Fragen kommen ganz ohne Modell aus.

## Antwortverhalten

- **Für alle:**
  - Zuerst die direkte Antwort in einem Satz, danach höchstens zwei, drei Sätze.
  - Kein Markdown, keine Listen, keine Datenaufzählungen. Zusammengefasst wird mit Anzahl, Summe und den wichtigsten Posten.
  - Markdown, das trotzdem kommt, wird entfernt (`tidyAnswer`).
  - Lange Karten zeigen nur die ersten sechs Zeilen, der Rest kommt mit „Alle n anzeigen“.
- **Allgemeiner Chat:**
  - Locker, warm und direkt, ohne Floskeln.
  - Lenkt Nicht-Geldthemen nicht auf Finanzen um und fragt bei Unklarem nach.
  - Sieht ohne Geldbezug keine persönlichen Daten. Dann darf er Allgemeinwissen mit Zahlen nennen; Geldbeträge, Links und Kontonummern müssen trotzdem belegt sein.
  - Smalltalk beantwortet er sofort mit natürlichen Sätzen, ohne Modell.
- **Spezialisten:**
  - Strikt an Fakten und Werkzeug-Ergebnis gebunden; jede Zahl muss belegt sein (`numbersBacked`). Zahlen aus der Frage selbst gelten als belegt („Kann man mit 3000 netto …?“).
  - Sie sehen nur den letzten Wortwechsel, der Chat den Verlauf.
- **Wann das Modell den Werkzeugtext umformuliert (`converseOn`):**
  - Nicht bei leeren Ergebnissen: „keine Daten“ bleibt der ehrliche Werkzeugsatz statt eines erfundenen Absatzes.
  - Nicht bei Werkzeugen, deren Text schon die Antwort ist (Überblicke, Rückblicke, Hinweise, „Warum …?“-Erklärungen, Was-wäre-wenn, Gehalt), außer bei Rat- und Meinungsfragen oder wenn nur das Modell das Werkzeug geraten hat.
  - Floskeln am Anfang („Kurz gesagt:“, „Du willst wissen …?“) und doppelte Sätze werden entfernt.
- **Kennzeichnung:** Jede Antwort trägt dezent den zuständigen Bereich (z. B. „Gehalt & Steuern · KI“). Er wird als optionales Feld `agent` im Chatverlauf gespeichert (JSON, keine Migration).

## Admin-Ansicht

Eine versteckte, rein lesende Seite unter **Einstellungen → „Assistent-Orchestrator“** (`/einstellungen/orchestrator`). Der Link steht dezent unter den Einstellungsbereichen, nicht in der Hauptnavigation.

- **Aufbau:** Baum vom Orchestrator über die drei Entscheidungsschritte (Regeln, Signalwörter, Modell-Rückfall) zu den vier Spezialisten und dem allgemeinen Chat, mit KI-Status.
- **Agenten:** Zuständigkeit, Kurzbeschreibung, Modell (Router und Hauptmodell aus `/api/ai/status`) und Zahl der letzten Läufe.
- **Letzte Läufe:** bis zu 50 Anfragen aus dem Chatverlauf mit Zeit, Agent, Weg, Status (beantwortet, Rückfrage, unklar, Fehler) und grober Dauer. Keine Token-Angaben.
- **Werkzeuge:** Tabelle je Agent; Werkzeuge, die Daten ändern, sind markiert und laufen nur nach Bestätigung.
- **Aktualisieren** lädt den KI-Status neu. Bearbeiten lässt sich nichts.

Dafür speichert jede Antwort im Chatverlauf zusätzlich die optionalen Felder `via` (Regel, Signal, Modell, Rückfall) und `ms` (Dauer). Das ist JSON im bestehenden Verlauf, keine Migration.

**Dateien:** `src/lib/assistant/orchestrator-info.ts` (Daten), `src/components/orchestrator-admin.tsx` (Ansicht), `src/app/(dashboard)/einstellungen/orchestrator/page.tsx` (Route).

## Chat-Test 1 (11.11.2026)

88 Anfragen über die echte Oberfläche mit lokalem Qwen3-8B und synthetischen Daten: Gehaltsabrechnungen plus Buchungen Juli bis November 2026 (Billa, Spar, Netflix, Spotify mit Preiserhöhung, Shell, Lieferando, Amazon mit Rückerstattung, doppelte Fitnessstudio-Abbuchung, mit Raphael geteilter Einkauf, Versicherung, Handy). Abgedeckt: Umsätze, Verträge, Budget & Prognose, Gehalt & Steuern, Wissen, Smalltalk, Grenzfälle, Tippfehler, Englisch, Unsinn.

Gefunden und behoben:

| Problem | Ursache | Korrektur |
|---|---|---|
| „Sollte ich das Lebensmittelbudget erhöhen?“ landete beim Chat und widersprach sich | Signalwort erkannte keine Komposita; verworfene Änderung verlor ihren Eigentümer; freie Antwort ohne Budgetzahlen | `\p{L}*budget\p{L}*`; verworfene Änderungen bleiben beim Eigentümer; neue Budget-Empfehlung aus dem Tempo der genannten Budgetzeile (`budgetAdvice`) |
| Weihnachtsgeld, Successbonus, Urlaubsgeld, „Bonus“ bekamen die nächste beliebige Sonderzahlung | Gehaltswerkzeug kannte die Frage nicht | `payrollAnswer(state, text)` nennt genau die gefragte Zahlung samt 6-%-Anteil, voll versteuertem Teil und Netto |
| „Warum zahle ich so viel Lohnsteuer?“ ergab erfundenen Text zur Steuer-Mappe | Regel schickte an die Arbeitnehmerveranlagung | Lohnsteuerfragen gehen an Gehalt: Anteil am Brutto, Grenzsteuersatz, Absetzbeträge |
| „Unterschied Brutto und Netto“ erklärte den „Brutto-Rauminhalt“ eines Gebäudes | Lexikon-Suche | Gehaltsbegriffe (Brutto/Netto, Jahressechstel, Sonderzahlung, Lohnsteuer, Überstunden) erklärt das Gehaltswerkzeug, mit eigenem Wert |
| „Werden Überstunden anders versteuert?“ war unsicher und weitschweifig | freie Antwort ohne Grundregel | feste Erklärung (§ 68 EStG, ohne erfundene Grenzbeträge); Gehaltsstimme nennt nur gesicherte Regeln |
| „Kann man mit 3000 netto in Wien gut leben?“ endete in „Da komme ich nicht mit“, die nächste Frage wurde als deren Bedeutung gelernt | Zahl aus der Frage galt als unbelegt; jede Folgenachricht galt als Umformulierung | Zahlen der Frage gelten als belegt; gelernt wird nur bei gemeinsamem Inhaltswort (`rephrases`); allgemeine „man“-Fragen gehen an den Chat |
| „Ist Spotify teurer geworden?“ und „Was soll ich heute kochen?“ öffneten einen alten Sparziel-Entwurf | jeder offene Entwurf im Verlauf galt als „in Arbeit“ | nur der Entwurf der letzten Antwort nimmt Folgeeingaben an |
| Spar und Lieferando als „kündbare Verträge“ und „teurer geworden“ | Abo-Erkennung sah monatliche Einkäufe als Abo | Alltagskategorien (Lebensmittel, Tanken, Lieferdienste …) zählen nie als Vertrag oder Preiserhöhung |
| „Wie viel für Tanken?“ fand nichts, „bei Shell getankt“ ging an den Monats-Puls | Tankstellen sind als Mobilität kategorisiert; „getankt“ war kein Signal | „Tanken“ sucht auch in Mobilität; „getankt“, „eingekauft“ sind Umsatz-Signale |
| „Was ist mit meiner Versicherung los?“: „keine Versicherung gefunden“ | Entwurf statt Vertragswerkzeug | geht an Verträge und zeigt die Versicherungen |
| „Wann läuft Netflix aus?“ ohne Netflix-Vertrag zeigte „Alle Ausgaben“ | Rückfall auf die Buchungssuche | sagt, dass der Vertrag fehlt, und zeigt die nächsten Fristen |
| „Was fällt dir auf?“: nur „1 Punkt fällt mir auf.“ | Text ohne Inhalt | nennt den Punkt |
| „Warum ist Billa Lebensmittel?“, „Wochenüberblick“: verdrehte Modellsätze | Modell formulierte fertige Werkzeugtexte um | `converseOn` (siehe oben) |
| „wo geht mein Geld hin“ ohne Daten: weitschweifig | Modell formulierte ein leeres Ergebnis aus | leere Ergebnisse behalten den Werkzeugsatz |
| „Buchungen über 100 Euro“ suchte unter „Transfer“ | Modell-Hinweis auf eine Buchhaltungskategorie | Transfer/Prüfen/Sonstiges nur, wenn die Frage sie nennt |
| „Kurz gesagt: …“ vor fast jeder Chat-Antwort | Beispielsatz im Prompt wurde nachgeplappert | Beispiel entfernt, Floskel wird abgeschnitten |
| „???“, „hmm“, „asdfgh“ ergaben einen Finanz-Absatz | an das Modell weitergereicht | freundliche Rückfrage ohne Modell |
| „how much did I spend on food in october“ ging an den Chat | englische Wörter unbekannt | „spend“, „spent“, „groceries“ und englische Monatsnamen |
| „Ich bin gestresst wegen Geld“ wurde als Fakt gemerkt | Gedächtnis erkannte „Ich bin …“ als Dauerfakt | Stimmungen und Sorgen werden nie automatisch gemerkt |

Nach den Korrekturen wurden alle 88 Anfragen erneut gestellt, dazu neun Nachtests für den allgemeinen Chat (Uhrzeit, Wetter, Wissen, Kochen, Budget senken):

- keine falsche Zuordnung und keine Datenaufzählung mehr gefunden;
- 61 von 88 Antworten ganz ohne Modell, Median 1,7 s bis zur fertigen Antwort im Browser;
- `npm run eval:assistant` unverändert: 97/98 goldene Fragen, 13/13 grenzwertige, alle Prompt-Injection-Tests bestanden;
- „Wie spät ist es in Tokio?“ erfand vorher eine Uhrzeit und wird jetzt aus der Uhr beantwortet.

Bewusst so gelassen: Formulierungen des kleinen Modells bei Gedichten, Witzen und Kochideen sind mal holprig; Beträge darin sind geprüft.

## Chat-Test 2 (11.11.2026)

Systematischer Test mit 946 Anfragen (249 verschiedene Fragen) über die echte Oberfläche, mit Qwen3-8B auf der NPU und denselben synthetischen Daten wie in Chat-Test 1. Nach jedem Lauf wurden die Fehler behoben, mit Unit-Tests abgesichert und im nächsten Lauf erneut geprüft.

| Lauf | Fragen | Inhalt |
|---|---|---|
| 1 | 159 | neun Gruppen: Umsätze, Verträge, Budget & Prognose, Gehalt & Steuern, allgemeiner Chat, Unklares, kombinierte Fragen, Folgefragen, typische Fehlerquellen |
| 2 | 196 | Lauf 1 plus 37 neue Formulierungen und eine Kette aus Merken, Vergessen und Pronomen („davon“, „Kündige das“) |
| 3 | 231 | Lauf 2 plus 35 neue Fragen |
| 3b, 3c | 71 | gezielte Nachtests der Korrekturen aus Lauf 3, mit neuen Formulierungen |
| 4 | 261 | alles aus Lauf 3, 3b und 3c |
| 4b | 28 | Nachtest der Korrekturen aus Lauf 4 im Gesprächsverlauf |

**Gefunden und behoben**

| Problem | Ursache | Korrektur |
|---|---|---|
| Erfundene Beträge („13 € bei MediaMarkt“) | Kleine Beträge galten als belegt | Jeder Euro-Betrag muss in Fakten, Werkzeug oder Frage stehen |
| „Wie hoch ist der Großglockner?“ → „1.028 m“; „Hauptstadt von Australien“ → Artikel über Divestment, später „Kanberra“ | Die Lexikon-Suche kannte nur Finanzbegriffe; das Modell riet | Faktenfragen schlagen den Gegenstand selbst nach (auch Orte, Personen und Gerichte); das Modell liest die Antwort aus dem Artikel |
| Kombinierte Fragen nur zur Hälfte beantwortet | Ein Agent pro Nachricht | `splitQuestion`: zwei bis drei Teile mit je eigenem Agenten; „es“ nach „mein Gehalt“ wird aufgelöst |
| „Mein Konto ist leer“ → „Du kannst heute 45 € ausgeben“ und wurde gemerkt; später erfundene Analyse | Monats-Puls und Gedächtnis reagierten auf das Wort „Konto“ | Freundliche feste Antwort mit nächsten Schritten; Stimmungen werden nie gemerkt |
| „Lösche alle Buchungen“ öffnete eine Bearbeitung | Bearbeitungsregel | Feste Antwort: per Chat wird nie alles gelöscht |
| Spar, Lieferando und Shell als Abo oder Vertrag | Monatliche Einkäufe sahen wie Abos aus | Alltagskategorien (auch Mobilität) zählen schon in der Abo-Erkennung nicht |
| Durchschnitt über Monate ohne Daten | Zeitraum ab Jahresbeginn | Durchschnitt ab der ersten Buchung („seit Juli 2026“) |
| Kategorie-Hinweise des Modells (Billa → „Guthabenkarten“) | Hinweis ungeprüft übernommen | Nur, wenn die Kategorie im Text vorkommt und kein Händler genannt ist |
| „1 Million“ als 1 € | Zahlwort unbekannt | Million und Mio. werden erkannt |
| „Was kann ich bis Sonntag noch ausgeben?“ → allgemeine Spartipps | „Was kann ich …“ galt als Ratfrage; Puls kannte „bis Sonntag“ nicht | Betragsfragen behalten den Werkzeugtext; Puls rechnet „diese Woche“, „bis Sonntag“ und „pro Tag bis zum Gehalt“ |
| „Wie viel bleibt mir pro Tag bis zum Gehalt?“ → Lohnzettel | „Gehalt“ zog zum Gehaltswerkzeug | Geht an den Monats-Puls |
| Gehaltsantworten zu allgemein | Werkzeug kannte die Frage nicht | Monat mit fälliger Sonderzahlung, Gehaltserhöhung, Sozialversicherung, Lohnsteuer seit Jahresbeginn, Grenzsteuersatz, Absetzbetrag, Verkehrsabsetzbetrag, Familienbonus |
| „Wofür geht das meiste Geld drauf?“ → „Wie viel kostet es?“ | Regel für Leistbarkeit griff zuerst | Kategorie-Aufteilung; ebenso „Kostenfresser“ |
| „Mehr als letzten?“, „What is my biggest expense?“ | Kurzform und Englisch unbekannt | Vergleich mit dem Vormonat; englische Fragen nach größter Ausgabe und Aufteilung |
| „Welche Fixkosten hab ich?“ ohne Plan: nur „keine eingetragen“ | Nur der Monatsplan wurde gelesen | Nennt zusätzlich die erkannten Verträge mit Monatssumme |
| „Was ist ein ETF?“: Lexikontext mit Klammern | Drei Sätze Rohtext | Zwei Sätze ohne Klammer-Einschübe |
| „Was ist Inflation?“, „Was ist der Leitzins?“ | Werkzeug nannte nur Werte, beim Leitzins zuerst die Sparzinsen | Erst die Bedeutung bzw. der EZB-Satz, dann die eigenen Zahlen |
| „Was ist ein Notgroschen?“ → Seitenbeschreibung | Bedienungshilfe statt Begriff | Erst die Bedeutung, dann die Karte mit den eigenen Werten |
| „Wo liegt mein Geld?“ → falsch sortierte Modellantwort | Kein Werkzeug | Kontostände |
| Witze in Endlosschleife, „Kasse“-Floskeln, „Bist du ein Mensch?“ → „Ja“ | Modell | Geprüfte Witze, Datum und Uhrzeit aus der Uhr, feste Antworten zu „Bist du eine KI/ein Mensch?“ |
| Filmtipps mit erfundenen Titeln und Jahren | Modell | Feste Listen bekannter Filme, Bücher und Serien, nur bei Empfehlungswünschen |
| „Buchtipp“ wiederholte den Filmtipp | Modell kopierte den Verlauf | Wiederholte Sätze werden entfernt; eine reine Kopie wird einmal ohne Verlauf neu gefragt |
| Unaufgeforderte Film- und Rezeptideen | Hinweise im festen Prompt | Hinweise nur, wenn die Frage danach fragt |
| „Wie wird das Wetter morgen?“ → „Kurz: App-Check.“ | Modell | Feste Antwort |
| „Kannst du das nochmal erklären?“ ohne Vorantwort → Selbstbeschreibung | Modell | Rückfrage „Was soll ich dir genauer erklären?“ |

**Prompts:** Antwortregeln, Grundregeln und alle Stimmen sind kürzer und genauer. Der allgemeine Chat bleibt beim Thema, spricht nicht über die App oder „die Kasse“ und hat 320 statt 400 Token. Floskeln wie „Gerne!“ und ein wiederholtes „Wo liegt dein Geld?“ am Anfang werden entfernt. Die Beispiele des Orchestrators wurden korrigiert.

**Ergebnis (Lauf 4, 261 Fragen):**

- 201 von 261 Antworten (77 %) kamen ganz ohne Modell; in Lauf 1 waren es 91 von 159 (57 %);
- Median 1,6 s bis zur fertigen Antwort im Browser (Lauf 1: 1,8 s);
- 256 von 261 Entscheidungen fielen per Regel, 2 per Signalwort, 1 durch das Modell;
- keine falsche Zuordnung, kein Daten-Dump und kein erfundener Betrag mehr gefunden;
- `npm run eval:assistant`: 97/98 goldene Fragen, 19/19 grenzwertige, alle Prompt-Injection-Tests bestanden; Modell-Routing Median 1,6 s.

Weiter holprig: Gedichte, Reime und Witze zu einem bestimmten Thema („über Katzen“) schreibt das Modell selbst. Bei unbekannten Gerichten kann die Zubereitung ungenau sein.

## Messung (Qwen3-8B, NPU, lokale Daten)

| | vorher | nachher |
|---|---|---|
| Goldene Fragen | 97/98 | 97/98 |
| Grenzwertige Fragen (Orchestrator) | – | 13/13 |
| KI-Aufrufe für die Interpretation je Nachricht | bis 2 | höchstens 1 |
| Dauer einer Modell-Interpretation (Median) | 8,3 s | 4,0 s |
| Modell-Routing (Median) | – | 1,6 s |
| Kontext der freien Antwort (echte Daten) | 6.300 Zeichen | 0–72 % davon: Chat 0–19 %, Verträge 14 %, Gehalt 19 %, Umsätze 49 %, Budget 72 % |
| Erstes Wort der freien Antwort | 2,2–5,1 s | Chat und Verträge ≈ 1,5 s, Budget 2,0–4,8 s |

Die verbleibende Abweichung („warum hab ich am Monatsende immer so wenig Geld“ → Hinweise statt Erklärung) war auch vorher falsch. Sie landet beim richtigen Spezialisten, der als Warum-Frage in Worten antwortet.

## Tests

- `orchestrator.test.ts`:
  - höchstens vier Spezialisten, jedes Werkzeug mit genau einem Eigentümer;
  - typische und grenzwertige Fragen;
  - Rückfall bei Unklarheit.
- `assistant.test.ts`:
  - Chat ohne Modellaufruf;
  - genau ein Ein-Wort-Aufruf mit Rückfall;
  - Spezialist sieht nur eigene Werkzeuge.
- `speed.test.ts`: Stimme je Agent, Allgemeinwissen nur im Chat ohne persönliche Daten, `tidyAnswer`.
- `payroll.test.ts`: Gehaltswerkzeug und Fakten-Ausschnitte.
- `eval-cases.test.ts`: Eigentümer jeder goldenen Frage; grenzwertige Fragen nie beim falschen Spezialisten.
- `tests/assistant-orchestrator.spec.ts`: Smalltalk, allgemeine Frage ohne persönliche Fakten und Gehaltsfrage im Browser bei 390 und 1440 px.
- `tests/assistant-admin.spec.ts`: Admin-Ansicht nur über die Einstellungen erreichbar, alle vier Bereiche, kein horizontales Scrollen bei 1440 px hell und 390 px dunkel.
- `orchestrator-info.test.ts`, `orchestrator-admin.test.tsx`: Läufe aus dem Verlauf, Status, Werkzeugliste und Darstellung.
- Korrekturen aus dem Chat-Test: `conversation.test.ts` (`converseOn`, Budget-Empfehlung), `payroll.test.ts`, `pulse.test.ts`, `copilot.test.ts`, `cancel.test.ts`, `learning.test.ts`, `smalltalk.test.ts`, `phrasing.test.ts`, `speed.test.ts`.
- Korrekturen aus Chat-Test 2: `fixed-replies.test.ts` (feste Antworten, Rechnen, Rückfragen), `combined.test.ts` (kombinierte Fragen), `knowledge.test.ts` (Faktenfragen, allgemeine Artikel), `conversation.test.ts` (kopierte Sätze), `check.test.ts`, `everyday.test.ts`, `market.test.ts`, `insights.test.ts`, `orchestrator.test.ts`, `speed.test.ts` (Themenhinweise, knappe Faktenantwort).
- `npm run eval:assistant`: zeigt je Frage Agent, Weg (Regel, Signal, Modell, Rückfall), Zahl der KI-Aufrufe und Dauer.

## Grenzen

- Die Signalwörter sind bewusst knapp gehalten. Was sie nicht eindeutig zuordnen, entscheidet das Modell oder, im Zweifel, der Chat.
- Bestehende Regelfehler einzelner Werkzeuge bleiben, wo sie keine falsche Zuständigkeit verursachen.
- Kombinierte Fragen werden nur geteilt, wenn jeder Teil für sich steht. Verweist ein Teil zurück („… und was kosten sie im Jahr?“), antwortet ein Agent auf beides.
- Faktenfragen brauchen das Internet. Offline antwortet das Modell knapp aus eigenem Wissen.
