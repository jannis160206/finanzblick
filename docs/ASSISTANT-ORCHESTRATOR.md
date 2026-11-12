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
| **Umsätze** | vergangene Buchungen, Ausgaben und Einnahmen, Händler, Kategorien, Monats- und Jahresrückblick, Doppel- und verdächtige Buchungen, Rückerstattungen, offene Bestellungen, geteilte Kosten; Buchungen bearbeiten, löschen, taggen und teilen | `query`, `booking`, `rule`, `cleanup`, `why`, `security`, `refunds`, `context`, `orders`, `shared`, `month_review`, `review` |
| **Verträge** | Abos und Verträge, Kosten, Laufzeit, Fristen, Kündigen; Verträge Schritt für Schritt anlegen, ändern, bestätigen, ausblenden, als gekündigt markieren | `contracts`, `cancel`, `contract_new`, `contract_edit` |
| **Budget & Prognose** | Monatsplan, Kontostände, Prognose, Sparziele, geplante Ausgaben, „Geht sich das aus?“, Spartipps, Anlegen, Kredite; Budgets, Monatsplan-Positionen, Monatswerte und Kontoregeln ändern | `budget`, `budget_plan`, `pulse`, `forecast`, `funds`, `account_rule`, Entwürfe (`savings_goal`, `expense`, `affordability`), `edit`, `batch`, `whatif`, `coach`, `check`, `briefing`, `insights`, `accounts`, `amex`, `networth`, `depot`, `loan` |
| **Gehalt & Steuern** | Lohnabrechnung, netto und brutto, Sonderzahlungen samt Anteil zu 6 % und voll versteuert, Jahressechstel, Arbeitnehmerveranlagung | `payroll` (auch Successbonus), `tax`, `homeoffice` |
| **Allgemeiner Chat** (kein Spezialist, Rückfallebene) | Begrüßung, allgemeine Geldfragen, Finanzbegriffe, Bedienung, Marktdaten, Gedächtnis; alles Unklare. Fachfremde Themen lehnt er ab | `help`, `explain`, `knowledge`, `market`, `memory`, `remember`, `forget`, `changes`, `undo`, `reminder`, `ask` |

**Annahme:** Die Vorgabe „strikt maximal 4 Spezialisten“ nennt fünf Bereiche. Der allgemeine Chat ist deshalb kein Spezialist, sondern die Rückfallebene des Orchestrators. So bleibt es bei vier Spezialisten.

**Dateien**

- `src/lib/assistant/orchestrator.ts`: Agenten, Werkzeug-Eigentümer, Signalwörter, `routeByRules`, `parseAgent`.
- `src/lib/ai/specialists.ts`: Orchestrator-Prompt (ein Wort), Werkzeug-Prompt je Spezialist und Stimme je Agent.
- `src/lib/ai/assistant.ts`: Ablauf auf dem Server.
- `src/lib/assistant/specialist-context.ts`: Fakten-Ausschnitt und Kontext-Werkzeug je Agent.
- `src/lib/assistant/payroll.ts`: neues Werkzeug für Gehalt & Steuern.
- `src/lib/assistant/fixed-replies.ts`: feste Antworten ohne Modell (Navigation, Farbschema, Rechnen, „Mein Konto ist leer“, Links für Aktionen, die nur auf ihrer Seite gehen) und Rückfragen auf einzelne Wörter.
- `src/lib/assistant/scope.ts`: erkennt fachfremde Themen und antwortet mit einem freundlichen Nein.
- `src/lib/assistant/contract-draft.ts`, `contract-actions.ts`, `contract-requests.ts`, `booking-actions.ts`, `plan-rows.ts`: App-Aktionen im Chat (siehe unten).
- `src/lib/assistant/combined.ts`: teilt kombinierte Fragen in Teilfragen mit je eigenem Werkzeug.

## Ablauf und KI-Aufrufe

1. **Regeln (0 Aufrufe):**
   - Begrüßung, Dank und „Wer bist du?“ beantwortet der Chat sofort.
   - Fachfremde Themen bekommen ohne Modell ein freundliches Nein mit drei Finanzfragen als Vorschlag (siehe „Nur Finanzen und die App“).
   - Feste Antworten ohne Modell: Rechnen („15 % von 2400“), Navigation („Öffne die Verträge“), Farbschema, „Mein Konto ist leer“, „Lösche alle Buchungen“.
   - Kombinierte Fragen („Wie hoch ist mein Gehalt und wann kommt es?“) werden in Teile zerlegt; jeder Teil bekommt sein eigenes Werkzeug, höchstens ein Teil eine freie Antwort.
   - Finanzbegriffe („Was ist ein ETF?“) beantwortet `knowledge` zuerst aus dem lokalen Finanzwissen (siehe „Lokales Finanzwissen“); nur ohne sicheren Treffer schlägt er in der Wikipedia nach. Allgemeine Artikel sucht er nicht mehr.
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
  - Hilft nur bei Geld, Finanzen, Verträgen, Steuern und der App; Kosten von Freizeit, Abos und Streaming zählen dazu. Bei Unklarem fragt er nach.
  - Sieht ohne Geldbezug keine persönlichen Daten. Dann darf er allgemeines Finanzwissen mit Zahlen nennen; Geldbeträge, Links und Kontonummern müssen trotzdem belegt sein.
  - Begrüßung und Dank beantwortet er sofort mit natürlichen Sätzen, ohne Modell.
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

Überholt seit dem Finanz-Fokus (unten): Witze, Gedichte, Film- und Buchtipps, Rezepte und allgemeine Faktenfragen beantwortet der Assistent nicht mehr; die Korrekturen dazu sind entfernt.

## Nur Finanzen und die App

Der Assistent hilft nur bei Geld und bei dem, was die App kann. Fachfremdes lehnt er ab, ohne das Modell zu fragen (`scope.ts`): „Film-, Serien-, Buch- und Musiktipps gebe ich nicht – ich bin nur für deine Finanzen und die App da“, dazu drei Finanzfragen als Knöpfe.

- **Abgelehnt:** Filme, Serien, Bücher, Musik, Podcasts, Wetter, Rezepte und Kochen, Allgemeinwissen („Wie hoch ist der Großglockner?“, „Wer hat die Glühbirne erfunden?“), Sport, Politik, Übersetzen, Sprachen, Programmieren, Gesundheit, Lebenslauf und Bewerbung, E-Mails, Witze, Gedichte, Datum und Uhrzeit, Vorlieben des Assistenten.
- **Geldbezug geht vor:** „Wie viel gebe ich für Musik-Streaming aus?“, „Ich will ins Kino, geht sich das diesen Monat noch aus?“ oder „Lohnt sich ein Spotify Familienabo?“ bleiben Finanzfragen. Kreative Bitten („ein Gedicht über Sparen“) bleiben abgelehnt.
- **Entfernt:** die allgemeine Wikipedia-Suche für Faktenfragen (`general=1`), Film- und Rezepthinweise, Witze, Datum und Uhrzeit. `knowledge` erklärt nur noch Finanzbegriffe.
- **Allgemeiner Chat:** beantwortet Geldanlage (auch Bitcoin), Preis- und Kostenfragen und persönlichen Smalltalk mit Überleitung zu den Finanzen. Ganz Fachfremdes, das die Regeln nicht kennen, lehnt er in einem Satz ab.

## Aktionen im Chat

Was die App von Hand kann, geht auch im Chat, mit denselben Prüfungen (`applyOperations` nutzt dieselbe Logik wie die Seiten). Jede Änderung ist zuerst eine Vorschau mit Vorher/Nachher und wird erst mit „Bestätigen“ oder einem kurzen „Ja“ gespeichert. „Nein“ oder „Verwerfen“ verwirft sie, „Ja, aber …“ gilt als Korrektur. Jede Änderung lässt sich einzeln rückgängig machen.

| Bereich | Beispiele | Operation |
|---|---|---|
| Verträge anlegen (Schritt für Schritt wie im Vertragsdialog) | „Leg einen neuen Vertrag an“ → Name, Betrag, Kategorie, Kündigungsfrist, Mindestlaufzeit („12 Monate“, „bis 31.12.2027“), Rhythmus, nächste Abbuchung, automatische Zuordnung → Vorschau | `contract_create` |
| Verträge ändern | „Netflix kostet jetzt 15,99 €“, „Kündigungsfrist von Magenta ist 3 Monate“, „Netflix wird ab Jänner jährlich abgerechnet“, „Bestätige alle Verträge“, „Blende FITINN aus“, „Netflix ist gekündigt zum 31.12.“, „Lösch den Vertrag …“ (nur selbst angelegte) | `contract_update`, `contract_action` |
| Buchungen | „Lösch die Buchung vom 24.10.“ (eine benannte, höchstens 10), „Tagge die Pizzeria-Buchungen mit Essen gehen“, „Teil die Buchung vom 11.10. mit Raphael“, umbenennen, kategorisieren, ignorieren, aus dem Plan nehmen, als geprüft markieren | `transaction_delete`, `transaction_tag`, `transaction_update`, `categorize` |
| Sparziele (Schritt für Schritt wie im Zieldialog) | „Ich möchte ein Sparziel anlegen“ → Name, Betrag, Datum oder Monatsrate, Startkapital, Konto → Vorschau mit „Anlegen“; ändern, aussetzen, löschen | wie bisher |
| Monatsplan und Budgets | „Füg eine Position Strom mit 60 € pro Monat hinzu“, „Setze Tanken im Dezember auf 150 €“, „Tanken ab Jänner auf 120 €“, „… wieder auf automatisch“, „Setze das Lebensmittel-Budget auf 400 €“ | `plan_row_save`, `plan_row_delete`, `plan_value`, Budget |
| Konten und Gehalt | „Das Girokonto ist für alle Ausgaben“ (bisher ohne Vorschau gespeichert), „Lösch die Kontoregel für Girokonto“, „Setze den Successbonus auf 15 %“ | `account_rule`, `account_rule_delete`, `bonus_percent` |
| Nur als Link | Bank- und Google-Anmeldung, Datei-Uploads, Benachrichtigungen, Backups | – |

Ein offener Entwurf nimmt nur Antworten auf seine Frage an. Begrüßungen, fachfremde Themen und neue Fragen beantwortet der Assistent normal, und der Entwurf wartet (`leavesDraft`). Kurze Antworten auf die Fragen des Sparziel-Dialogs füllt der Server ohne Modell aus. Ein Schritt dauert damit ~1,6 s statt 10–30 s.

## Chat-Test 3 (12.11.2026)

307 Anfragen in fünf Läufen (155 verschiedene) über die echte Oberfläche mit lokalem Qwen3-8B und synthetischen Daten. Bestätigungen liefen als echter Klick oder als getipptes „Ja“, danach wurde der gespeicherte Stand im Browser geprüft.

| Problem | Ursache | Korrektur |
|---|---|---|
| Offener Entwurf schluckte „Wie geht es dir?“ und fachfremde Fragen („Wie viel kostet ‚Politik‘?“) | Jede Nachricht galt als Antwort auf den Entwurf | `leavesDraft`: Begrüßungen, andere Themen und neue Fragen verlassen den Entwurf |
| „Ja“ unter einer Vorschau: keine Antwort bzw. nur „Passt“, nichts gespeichert | Nur der Knopf speicherte | Kurzes „Ja“ speichert, „Nein“ verwirft, mit kurzer Rückmeldung |
| „Wie viel gebe ich für Musik-Streaming aus?“, „Kino … geht sich das aus?“ abgelehnt | Themenwort schlug Geldbezug | Ausgaben- und Leistbarkeitsfragen gehen immer vor |
| „Wie viel gebe ich für Versicherungen aus?“ → Ausgabe-Entwurf und erfundene Antwort | „gebe … aus“ las sich wie eine neue Ausgabe | Ausgabenfrage (`query`); „Streaming“ zählt als Abonnements |
| Mindestlaufzeit „12 Monate“ nicht verstanden | Nur Datum erlaubt | Dauer in Monaten oder Jahren ab heute |
| „Ändere den Netflix Betrag …“ → „Welches meinst du? Motorrad“ | Bearbeitung kannte keine Verträge | Rückfall auf den genannten Vertrag |
| „Netflix wird ab Jänner jährlich abgerechnet“ → Modellantwort | Muster kannte „abgerechnet“ und „ab Jänner“ nicht | Vertragsänderung |
| „Kündige Spotify“ ließ den Vertrag unverändert | Nur Kündigungsschreiben | Zusätzlich Knopf „… ist gekündigt (zum …)“ |
| „Setze Tanken im Dezember auf 150 €“ änderte das Budget ab sofort | Budget ohne Monat | Mit Monat oder „ab …“ wird der Monatswert gesetzt |
| „… war nicht mit Raphael geteilt“ → Übersicht offener Beträge | Kein Teilen per Chat | Teilen wie in den Umsätzen; Rücknahme ehrlich erklärt (geht auch dort nicht) |
| „Ich möchte ein Sparziel anlegen“ → Ziel „Sparziel“; „Urlaub in Japan“ → „Urlaub“ (gesperrter Name) | Modell bzw. Regel nahmen ein Füllwort | Allgemeine Wörter sind kein Name; die Antwort auf die Namensfrage zählt ganz |
| „Nein“ auf die Konto-Frage beim Startkapital wiederholte die Frage | Kein Ausweg | „Nein“ heißt kein Startkapital |
| „Erhöhe das Sparziel Urlaub in Japan …“ (nicht vorhanden) änderte das Urlaubs-Ziel der Einstellungen | Wort „Urlaub“ | Fragt nach dem richtigen Ziel |
| „Lösch die Kontoregel für Girokonto“ fand „Raiffeisen Giro“ nicht | Kein Alias beim Löschen | Gleiche Konto-Erkennung wie beim Anlegen |
| „Was war mein Netto im Oktober?“ → Oktober 2027 | Monat immer in der Zukunft | Vergangenheit meint den letzten Oktober, mit der passenden Abrechnung |
| „Mach ein Backup“ → erfundene Menüpunkte | Link-Antwort kannte die Wortfolge nicht | Link zu Einstellungen → Sicherung |
| „Erklär mir Zinseszins kurz“ → Begriff „zinseszins kurz“ | Füllwort am Ende | Füllwörter wie „kurz“, „einfach“ entfernt |
| Modell wiederholte die Frage in der Antwort; Prompt-Beispiel tauchte in Antworten auf; zu strenge Ablehnung bei Bitcoin | Kleines Modell | Wiederholte Frage wird entfernt, Prompts ohne kopierbare Beispiele, Ablehnung nur ganz ohne Geldbezug |

**Ergebnis:**

- Im letzten vollständigen Lauf (156 Schritte, 131 Fragen) kamen 94 Antworten ohne Modell; der Median bis zur fertigen Antwort lag bei 1,7 s.
- Alle bestätigten Änderungen standen danach im gespeicherten Stand: Verträge, gelöschte und geteilte Buchungen, Tags, Positionen, Kontoregeln, Sparziele.
- `npm run eval:assistant`: 107/108 goldene Fragen (davon 10 neue App-Aktionen), 22/22 grenzwertige, alle Prompt-Injection-Tests bestanden.

Weiter holprig: Unbekannte fachfremde Fragen, die die Wortlisten nicht kennen, beantwortet das kleine Modell mal mit einer Ablehnung, mal knapp inhaltlich. „Was kostet ein Kinobesuch?“ bekommt ohne belegbare Zahl keine Betragsantwort. Einmal blieb eine Antwort beim Modellserver hängen; das war nicht wiederholbar.

## Live-Status und Chat-Oberfläche

Statt eines festen „Denkt nach“ zeigt der Chat, was gerade passiert. Die Statuszeile steht über der laufenden Antwort und verschwindet mit der fertigen Antwort.

- **Status je Schritt** (`src/lib/assistant/status.ts`):
  - „Lese deine Nachricht…“, dann „Verstehe deine Frage…“, während der Orchestrator entscheidet;
  - danach je Werkzeug, z. B. „Analysiere deine Buchungen…“, „Prüfe deine Verträge…“, „Berechne dein freies Budget…“, „Lese deine Lohnabrechnungen…“, „Suche passendes Wissen…“, „Hole aktuelle Marktdaten…“;
  - „Formuliere die Antwort…“ während des Streamings.
  - Ein Test stellt sicher, dass jedes Werkzeug einen Status hat.
- **Drei Punkte** (`ThinkingDots`): eine Welle aus Heben, Wachsen und Aufhellen (Motion, 1,05 s, 0,15 s versetzt). Neue Statustexte gleiten aus einer leichten Unschärfe herein.
- **Nachrichten:** neue Nachrichten federn herein (Feder 300/28, leichte Skalierung und Verschiebung, eigene von rechts). Gestreamte Wörter blenden einzeln aus einer leichten Unschärfe ein (CSS, nur `opacity` und `filter`).
- **Aktionen unter Antworten:** Kopieren (mit „Kopiert“ für Screenreader), Neu generieren (nur bei der letzten KI-Antwort), Hilfreich/Nicht hilfreich. Ältere Antworten zeigen die Leiste auf Geräten mit Maus erst bei Hover oder Fokus.
- **Eingabe:** wächst mit dem Text (`field-sizing: content`, höchstens 12 Zeilen). Enter sendet, Shift+Enter bricht um, und während einer IME-Eingabe sendet Enter nicht. Während der Antwort wird Senden zu **Stopp**: Die Anfrage wird abgebrochen, schon gestreamter Text bleibt mit „…“ stehen und lässt sich neu generieren.
- **Leerer Chat:** Begrüßung „Wobei kann ich dir helfen?“ mit drei Vorschlägen („Was habe ich diesen Monat ausgegeben?“ → Umsätze, „Zeige mir meine Verträge“ → Verträge, „Wie viel ist noch frei?“ → Monats-Puls). Bis zur ersten Frage bleibt die Begrüßung im Blick; danach scrollt der Chat zur neuesten Nachricht.
- **Weniger Bewegung:** Mit `prefers-reduced-motion` oder der Einstellung in der App gibt es nur kurze Überblendungen, keine Bewegung. Alle Animationen nutzen nur `transform`, `opacity` und `filter`.

**Dateien:** `src/components/assistant-chat-parts.tsx` (Punkte, Statuszeile, Streaming-Text, Einblenden, leerer Chat, Aktionen, Senden/Stopp), `src/components/finance-assistant.tsx` (Ablauf, Abbruch, Neu generieren), `src/app/globals.css` (`.assistant-word`).

## Lokales Finanzwissen (RAG)

Ein kleiner, lokaler Wissensspeicher für allgemeine Finanzfragen („Wie viel sollte man als Notgroschen haben?“, „Was ist die 50/30/20-Regel?“, „Wann lohnt sich die Arbeitnehmerveranlagung?“). Ohne Server, ohne Cloud und ohne Framework.

- **Wissen:** 51 kurze, geprüfte Abschnitte in `src/lib/knowledge-base/corpus.ts` zu Budget, Sparen, Anlegen, Schulden, Verträgen, Steuern (Österreich) und Bank. Zahlen zu Fristen und Steuern stammen aus denselben Quellen wie die App (`contract-types.ts`, `wage-tax-at.ts`).
- **Einbettung:** `Qwen3-Embedding-0.6B` (int8, CPU) läuft im selben OpenVINO Model Server wie das Sprachmodell. Die Vektoren werden auf 512 Dimensionen gekürzt (Matryoshka) und liegen vorberechnet in `vectors.json` (etwa 140 KB). Fragen bekommen die Qwen3-Anweisung „Given a question about personal finance …“ vorangestellt.
- **Speicher und Suche:** `sqlite-vec` als Erweiterung im eingebauten `node:sqlite`, im Arbeitsspeicher und erst bei der ersten Wissensfrage aufgebaut:
  - Vektorsuche (`vec0`, Kosinus-Abstand);
  - Stichwortsuche (FTS5, Trigramme, ohne Akzente);
  - zusammengeführt mit Reciprocal Rank Fusion (k = 60).
- **Knapper Kontext:** höchstens drei Treffer. Ein Treffer zählt nur, wenn er nah genug ist (Abstand ≤ 0,56, mit Stichwort-Treffer ≤ 0,59) und nicht weit hinter dem besten liegt.
- **Ohne Einbettungsmodell:** Die Suche fällt auf Stichwörter in Titel und Suchwörtern zurück; die App läuft normal weiter.
- **Wer entscheidet:** Der Orchestrator (`wantsKnowledge`). Gesucht wird nur bei allgemeinen Geld- und Ratfragen ohne eigenes Datenwerkzeug („Was ist …“, „Lohnt sich …“, „Tipps …“, „Regel …“). Fragen zu eigenen Daten und App-Aktionen warten nie darauf.
- **Verwendung:**
  - Beim Werkzeug `knowledge` beantwortet ein sicherer Treffer (Abstand ≤ 0,45) die Frage direkt, ohne Modell und ohne Internet, mit dem Hinweis „Aus dem lokalen Finanzwissen von Finanzblick“.
  - Sonst gehen die Treffer als belegte Evidenz in die freie Antwort. Zahlen in der Antwort müssen darin belegt sein, und unter der Antwort steht dezent „Wissen: …“.
  - Ohne Treffer bleibt alles wie vorher.
- **Geschwindigkeit:**
  - hybride Suche etwa 55 ms;
  - Einbettung einer Frage etwa 90 ms (CPU);
  - Zeitlimit 4 s, danach wird ohne Wissen geantwortet.
- **Pflege:** Nach Änderungen am Wissen `npm run knowledge:index` ausführen (braucht den Modellserver). Ein Test schlägt fehl, solange Vektoren zu geänderten Abschnitten fehlen.

**Dateien:** `src/lib/knowledge-base/` (`corpus.ts`, `query.ts`, `search.ts`, `vectors.ts`, `vectors.json`), `src/lib/ai/embeddings.ts`, `src/app/api/ai/knowledge/route.ts`, `scripts/knowledge-index.ts`, `wantsKnowledge` in `src/lib/assistant/orchestrator.ts`.

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
- Finanz-Fokus und App-Aktionen: `scope.test.ts` (fachfremde Themen, Geldbezug geht vor), `app-actions.test.ts` (jede neue Operation samt Rückgängig), `app-chat.test.ts` (Routing, Vertragsdialog Schritt für Schritt, Ja/Abbrechen, Buchungen, Monatsplan, Kontoregeln, Successbonus, Links).
- Chat-Oberfläche und Wissen: `assistant-chat-parts.test.tsx` (Senden wird zu Stopp, Kopieren mit Rückmeldung, Vorschläge, Statuszeile), `knowledge-routing.test.ts` (wann Wissen gesucht wird, Status je Werkzeug), `search.test.ts` (hybride Suche, Schwellen, Stichwort-Rückfall, aktuelle Vektoren).
- `npm run eval:assistant`: zeigt je Frage Agent, Weg (Regel, Signal, Modell, Rückfall), Zahl der KI-Aufrufe und Dauer.

## Grenzen

- Die Signalwörter sind bewusst knapp gehalten. Was sie nicht eindeutig zuordnen, entscheidet das Modell oder, im Zweifel, der Chat.
- Bestehende Regelfehler einzelner Werkzeuge bleiben, wo sie keine falsche Zuständigkeit verursachen.
- Kombinierte Fragen werden nur geteilt, wenn jeder Teil für sich steht. Verweist ein Teil zurück („… und was kosten sie im Jahr?“), antwortet ein Agent auf beides.
- Finanzbegriffe beantwortet er zuerst aus dem lokalen Wissen; was dort fehlt, schlägt er online nach. Offline und ohne lokalen Treffer sagt er ehrlich, dass er nichts Verlässliches gefunden hat.
- Das lokale Wissen ist bewusst klein (51 Abschnitte) und allgemein; es ersetzt keine Steuer- oder Anlageberatung.
- Die Themen-Prüfung arbeitet mit Wortlisten. Seltene fachfremde Fragen ohne bekanntes Wort gehen an den allgemeinen Chat, dessen Prompt ebenfalls nur Finanzen erlaubt.
- Nicht im Chat: Buchungen von Hand anlegen (gibt es in der App nicht), Bank- und Google-Anmeldung, Datei-Uploads, Benachrichtigungen, Erscheinungsbild und Backups (nur Link zur Seite), „Alle Buchungen löschen“ und eine geteilte Buchung wieder ungeteilt stellen (beides geht auch in der App nicht). Beim Sparziel gibt es statt „So schnell wie möglich“ die Wahl zwischen Datum und Monatsrate.
