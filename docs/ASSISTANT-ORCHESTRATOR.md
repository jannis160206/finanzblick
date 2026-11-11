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

## Ablauf und KI-Aufrufe

1. **Regeln (0 Aufrufe):**
   - Smalltalk und kreative Bitten („Schreib mir ein Gedicht …“) gehen an den Chat.
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
  - Strikt an Fakten und Werkzeug-Ergebnis gebunden; jede Zahl muss belegt sein (`numbersBacked`).
  - Sie sehen nur den letzten Wortwechsel, der Chat den Verlauf.
- **Kennzeichnung:** Jede Antwort trägt dezent den zuständigen Bereich (z. B. „Gehalt & Steuern · KI“). Er wird als optionales Feld `agent` im Chatverlauf gespeichert (JSON, keine Migration).

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
- `npm run eval:assistant`: zeigt je Frage Agent, Weg (Regel, Signal, Modell, Rückfall), Zahl der KI-Aufrufe und Dauer.

## Grenzen

- Die Signalwörter sind bewusst knapp gehalten. Was sie nicht eindeutig zuordnen, entscheidet das Modell oder, im Zweifel, der Chat.
- Bestehende Regelfehler einzelner Werkzeuge bleiben, wo sie keine falsche Zuständigkeit verursachen. Ein Beispiel ist „Was ist mit meiner Versicherung los?“: Die Regeln erkennen eine Ausgabe. Weil es eine Frage ohne Betrag ist, verwirft der Chat den Entwurf und leitet über die Signalwörter an Verträge weiter.
