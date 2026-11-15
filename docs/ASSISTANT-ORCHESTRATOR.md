# Finanz-Assistent: Agent-Plattform mit Orchestrator, Spezialisten-Agenten und Werkzeugen

Stand: 15.11.2026

## Ausgangslage (vorher)

- **Ein Router für alles:** `/api/ai/assistant` schickte jede unklare Nachricht mit einem großen Prompt (48 Werkzeuge, rund 60 Beispiele, alle Kategorien, sechs Verlaufszeilen) an das Modell. Bei einem Fehler des Router-Modells folgte ein zweiter Aufruf mit dem Hauptmodell.
- **Eine Stimme für alles:** Freie Antworten bekamen immer alle Fakten (mit echten Daten rund 6.300 Zeichen), auch für Smalltalk oder Wissensfragen.
- **Bis zu drei KI-Aufrufe pro Nachricht:** Router-Modell, Hauptmodell, freie Antwort.
- **Gemessen mit Qwen3-8B auf der NPU** (`npm run eval:assistant`):
  - 97 von 98 goldenen Fragen richtig;
  - Modellaufrufe des Routers dauerten 5–11 s (Median 8,3 s, Ausreißer 23 s).

## Lückenanalyse und Recherche (15.11.2026)

Vorlage war eine Agent-Plattform mit Werkzeug-Repo, Agent-Repo (Modell, Limits, versionierte Prompts), Wissen je Agent, Daten-Katalog, Topologie, Läufen und Evals. Der Assistent war davon **nur teilweise** so gebaut:

| Baustein der Vorlage | vorher | jetzt |
| --- | --- | --- |
| Orchestrator als eigener Agent | Supervisor = ein Flash-Aufruf, der einen JSON-Plan mit ≤ 4 Werkzeugschritten lieferte; V4 Pro schrieb danach | Orchestrator-Agent (V4 Pro) mit eigener Schleife: delegiert per Werkzeugaufruf, liest Befunde, delegiert nach, schreibt die Antwort |
| Spezialisten als Agenten | nur Werkzeuggruppen im Code, ohne eigenes Modell, Schleife und Limits | fünf Agenten (Flash) mit eigenem Prompt, Wissen, Datenquellen, Werkzeugen und Limits; laufen parallel |
| Werkzeug-Repo | Beschreibungen fest im Code | jede Beschreibung im Agent-Repo bearbeitbar, gruppiert nach Datenquelle |
| Agent-Repo mit Versionen | eine Prompt-Datei ohne Verlauf | `agent-repo.json`: Prompts, Modell-Stufe, Limits, Werkzeuge, Wissen – jede Änderung eine Version mit Zeit, Autor, Notiz; „Auf Code-Standard zurücksetzen“ |
| Wissen je Agent | nur globales RAG | Wissensdokumente je Agent, bei jedem Lauf im Prompt (≤ 12.000 Zeichen) |
| Daten-Katalog | – | 15 Datenquellen mit Körnung, Feldern und Beziehungen; je Agent seine Quellen |
| Topologie | CSS-Baum | Graph Chat → Orchestrator → Spezialisten → Werkzeuge → Datenquellen |
| Evals | nur CLI und intern im Prüfungs-Agent | eigene Seite: Gold-Eval starten, Verlauf mit fehlgeschlagenen Fällen; Läufe des Prüfungs-Agents erscheinen dort |

**Übernommen aus der Recherche** (nur Konzepte, kein Code):

- Anthropic, „How we built our multi-agent research system“ (2025): Orchestrator-Worker-Muster; der Lead delegiert mit Ziel, erwarteter Rückgabe und Grenzen, Subagenten laufen parallel und geben verdichtete Befunde zurück; Aufwand nach Frage skalieren; Werkzeugbeschreibungen entscheiden über die Qualität und gehören gepflegt; früh mit kleinen Eval-Sets und einem Modell als Richter prüfen. → Delegation als Werkzeug mit `aufgabe`, Limits je Agent, parallele Spezialisten, Werkzeug-Repo, Gold-Eval und Prüfungs-Agent als Richter.
- OpenAI Agents SDK, „Agents as tools“ gegenüber „Handoffs“: Beim Muster „Agents as tools“ behält der Manager die Kontrolle und schreibt die Antwort; ein Handoff gibt das Gespräch ab. → Spezialisten sind Werkzeuge des Orchestrators; nur der Änderungs-Workflow ist ein Handoff (Vorschau und Bestätigung).
- AG-UI-Protokoll: Lauf als Event-Stream (Text-Deltas, Werkzeugaufrufe, Status) und Werkzeuge, die der Client ausführt („Frontend Tools“). → Der Browser ist der Harness: Er führt die Werkzeuge auf den eigenen Daten aus, der Server liefert je Schritt einen NDJSON-Stream.
- Anthropic, „Building effective agents“ (2024): einfache, zusammensetzbare Muster statt Framework. → Kein Framework, keine neue Abhängigkeit.

## Architektur

```
Chat ─▶ Thin Orchestrator (Regeln: Systembefehle, Formulare) ─▶ Orchestrator-Agent (DeepSeek V4 Pro)
          umsaetze   ─▶ Umsätze (Flash)            ─▶ query, month_review, why, …   ─▶ Buchungen, Regeln, Bestellungen
          vertraege  ─▶ Verträge (Flash)           ─▶ contracts, cancel             ─▶ Verträge & Abos
          budget     ─▶ Budget & Prognose (Flash)  ─▶ pulse, forecast, funds, …     ─▶ Konten, Monatsplan, Ziele, Rechner
          gehalt     ─▶ Gehalt & Steuern (Flash)   ─▶ payroll, tax, homeoffice      ─▶ Lohnabrechnungen, Rechner
          recherche  ─▶ Recherche & Wissen (Flash) ─▶ web, knowledge, market, …     ─▶ Websuche, Finanzwissen, Marktdaten
          aenderung  ─▶ Änderungs-Workflow         ─▶ Vorschau und Bestätigung (wie bisher)
Hintergrund: Prüfungs-Agent (V4 Pro) · Rückfall ohne DeepSeek: lokales Routing und Qwen
```

- **Thin Orchestrator** (Regeln, 0 Aufrufe): nur Systembefehle (Datum, Uhrzeit, Navigation, Farbschema, Geräte-Einstellungen) und laufende Formulare (offener Entwurf, „Ja“/„Nein“ unter einer Vorschau, Rückgängig, Feedback). Alles andere bekommt der Orchestrator-Agent.
- **Orchestrator-Agent** (DeepSeek V4 Pro): sieht Nachricht, die letzten acht Nachrichten, den Datenüberblick (ohne Namen und IBANs), Sparziele, geplante Ausgaben und verlässliche Hinweise des Codes (Rechner, bestätigte frühere Antwort, aktueller Wert). Seine Werkzeuge sind die Spezialisten und `aenderung`. Er entscheidet bei jeder Anfrage selbst, wen er fragt – auch mehrere zugleich –, liest die Befunde, fragt nach und schreibt die Antwort gestreamt. Begrüßung, Dank und Smalltalk beantwortet er ohne Delegation in einem Schritt; jede Frage zu den eigenen Daten – auch ein Kontostand – geht an den zuständigen Spezialisten, weil nur dessen Werkzeuge genau rechnen und die Karten unter der Antwort liefern.
- **Spezialisten-Agenten** (DeepSeek Flash): bekommen ihre Aufgabe und zur Einordnung die Nachricht des Nutzers – keinen Verlauf und keinen Datenüberblick –, rufen ihre Lese-Werkzeuge (auch mehrere, in Schleife) und geben Befunde mit den Zahlen der Werkzeuge zurück. Formuliert wird nur vom Orchestrator.
- **Werkzeuge** laufen im Browser auf den eigenen Daten; jedes gehört genau einem Agenten. Ändernde Werkzeuge gehören nur dem Änderungs-Workflow und laufen nie in einem Agentenlauf.
- **Änderungs-Workflow:** Ruft der Orchestrator `aenderung`, endet der Lauf, und der bestehende Ablauf übernimmt: Regeln oder V4 Pro lesen die Details, der Chat zeigt die Vorschau, geändert wird erst nach „Ja“.
- **Chat-UI:** nur der Droide; welcher Agent gearbeitet hat, steht in den zugeklappten Details und in der Admin-Ansicht.

| Agent | Modell · Limits (Standard) | Werkzeuge | Datenquellen |
| --- | --- | --- | --- |
| **Orchestrator** | V4 Pro · 5 Schritte, 8 Aufrufe, 120 s, 900 Token | `umsaetze`, `vertraege`, `budget`, `gehalt`, `recherche`, `aenderung` | über die Spezialisten |
| **Umsätze** | Flash · 4 Schritte, 6 Aufrufe, 45 s, 700 Token | `query`, `review`, `why`, `orders`, `security`, `month_review`, `shared`, `refunds`, `context` | Buchungen, Kategorie-Regeln, Bestellungen, Aktuelle Seite |
| **Verträge** | Flash · wie oben | `contracts`, `cancel` | Verträge & Abos |
| **Budget & Prognose** | Flash · wie oben | `accounts`, `amex`, `budget`, `briefing`, `check`, `coach`, `depot`, `loan`, `forecast`, `whatif`, `pulse`, `funds`, `networth`, `insights` | Konten & Pockets, Monatsplan & Budgets, Sparziele & Ausgaben, Rechner |
| **Gehalt & Steuern** | Flash · wie oben | `payroll`, `tax`, `homeoffice` | Lohnabrechnungen, Rechner |
| **Recherche & Wissen** | Flash · wie oben | `web`, `knowledge`, `market`, `explain`, `help`, `memory`, `changes` | Websuche, Finanzwissen, Marktdaten, App-Hilfe, Gedächtnis |
| **Änderungen** (Workflow) | – | 18 ändernde Werkzeuge (Sparziel, Ausgabe, Buchung, Regel, Vertrag, Budget, Kontoregel, Gehalt, Erinnerung, Rückgängig …) | je Werkzeug |
| **Prüfungs-Agent** (Hintergrund) | V4 Pro · 2 Schritte, 300 s | – | Feedback-Datei, Agent-Repo |

Modell-Stufe und Limits sind Standards im Code und im Agent-Repo änderbar (Grenzen in `agentLimitBounds`).

**Dateien**

- `src/lib/agents/registry.ts`: einzige Quelle für Agenten, Werkzeuge (Beschreibung, Datenquelle, Eigentümer, Art), Datenquellen, Wissen und Daten-Katalog.
- `src/lib/agents/runtime.ts`: die Schleifen von Orchestrator und Spezialisten im Browser (Limits, Zeitlimit, parallele Delegation, Handoff an den Änderungs-Workflow); rein, ohne Browser getestet.
- `src/lib/ai/agent-step.ts`, `src/app/api/ai/agent/route.ts`: ein Schritt eines Agenten auf dem Server – System-Prompt aus dem Repo, Werkzeug-Definitionen, Verlauf des Laufs, Streaming mit Belegprüfung.
- `src/lib/server/agent-repo-store.ts`, `src/app/api/agent-repo/route.ts`: das versionierte Agent-Repo.
- `src/lib/ai/agent-prompts.ts`: Standard-Prompts aller Agenten, Antwortregeln, Prüfungs-Agent, lokales Routing, Stimmen und Werkzeug-Hinweise.
- `src/lib/ai/agent-eval.ts`: Routing und Antwort der Agenten ohne Daten, für Gold-Eval und Nachtest des Prüfungs-Agents.
- `src/lib/server/eval-runner.ts`, `evals-store.ts`, `src/app/api/assistant-evals/route.ts`: Eval-Läufe und ihr Verlauf.
- `src/lib/ai/assistant.ts`: Änderungs-Workflow und lokales Routing auf dem Server.
- `src/lib/assistant/orchestrator.ts`: Agenten-Ids, Werkzeug-Eigentümer, Thin Orchestrator (`orchestrate`), lokales Routing.
- `src/lib/assistant/fixed-replies.ts`: Systembefehle (`fixedCommand`) und Rechnen (`arithmetic`, als Hinweis an den Orchestrator).
- `src/lib/assistant/answer-view.ts`, `src/components/assistant-answer.tsx`: Antwort-Layout (Kennzahlen, Kacheln, Trends, Töne).
- `src/lib/ai/private-names.ts`, `src/lib/ai/route-support.ts`: Name des angemeldeten Nutzers je Anfrage, für die Maskierung vor DeepSeek.
- `src/lib/assistant/contract-draft.ts`, `contract-actions.ts`, `contract-requests.ts`, `booking-actions.ts`, `plan-rows.ts`: App-Aktionen im Chat (siehe unten).

## Ablauf und KI-Aufrufe

1. **Systembefehle (0 Aufrufe):** feste Befehle (`fixedCommand`) und laufende Formulare, wie bisher.
2. **Orchestrator, Schritt 1 (V4 Pro, gestreamt):** antwortet direkt (Begrüßung, Dank, Smalltalk) oder ruft Spezialisten und/oder `aenderung`. Mehrere Spezialisten in einem Schritt laufen gleichzeitig.
3. **Spezialisten (je 2 Aufrufe Flash):** Schritt 1 wählt Lese-Werkzeuge mit Teilfrage, der Browser führt sie aus (`executeTool`, Websuche über `/api/ai/web`), Schritt 2 fasst die Befunde zusammen. Braucht er mehr, ruft er weitere Werkzeuge, bis seine Limits erreicht sind; der letzte Schritt muss Worte liefern.
4. **Orchestrator, Schritt 2 (V4 Pro, gestreamt):** schreibt die Antwort aus den Befunden; die Ergebnisse der Werkzeuge legt die App darunter als Kennzahlen und Kacheln aus ([Antwort-Layout](#antwort-layout)). Er darf noch einmal delegieren, solange seine Limits reichen.
5. **Änderung:** `aenderung` beendet den Lauf; `/api/ai/assistant` übernimmt mit `delegated` (Spezialist liest die Details, Vorschau, Bestätigung).
6. **Ohne DeepSeek** (kein Key, Pause, Fehler eines Schritts): der Chat nutzt zwei Minuten lang die früheren lokalen Wege – Smalltalk, feste Antworten, Themen-Rückfragen, kombinierte Fragen, Folgefragen, gelernte Formulierungen, Regeln, Signalwörter, sonst ein Wort von Qwen –, und Qwen antwortet.

**Damit:** Eine Datenfrage kostet zwei Schritte des Orchestrators und zwei Flash-Aufrufe je Spezialist, Smalltalk einen Schritt. Gemessene Zeiten: siehe [Laufzeit der Agenten](#laufzeit-der-agenten), Kosten: siehe [Kosten](#kosten).

## Antwortverhalten

- **Für alle:**
  - Die Frage wird beantwortet: Reichen die Daten, gibt es eine klare Antwort oder Einschätzung statt einer Rückfrage. Fehlt eine Angabe, nimmt der Assistent das Naheliegende aus den Daten und sagt, wovon es abhängt. Zurückgefragt wird nur, wenn ohne die Angabe gar keine Antwort möglich ist.
  - Ohne Floskel und ohne die Frage zu wiederholen; eine kurze Frage bekommt eine kurze Antwort ohne Formatierung.
  - Formatiert wie ein guter Chat (siehe [Formatierung](#formatierung-markdown)): kurze Absätze, **fett** sparsam für die wichtigste Zahl, Listen für Aufzählungen und Schritte, Tabellen für Vergleiche, Überschriften nur bei mehrteiligen Antworten, Code-Blöcke nur für Code oder Formeln. Keine Datenaufzählungen, die die Karten schon zeigen.
  - Lange Karten zeigen nur die ersten sechs Zeilen, der Rest kommt mit „Alle n anzeigen“.
- **Allgemeiner Chat:**
  - Locker, warm und direkt, ohne Floskeln.
  - Hilft nur bei Geld, Finanzen, Verträgen, Steuern und der App; Kosten von Freizeit, Abos und Streaming zählen dazu.
  - Sieht ohne Geldbezug keine persönlichen Daten. Dann darf er allgemeines Finanzwissen mit Zahlen nennen; Geldbeträge, Links und Kontonummern müssen trotzdem belegt sein.
  - Begrüßung und Dank beantwortet er sofort mit natürlichen Sätzen, ohne Modell.
- **Spezialisten:**
  - Strikt an Fakten und Werkzeug-Ergebnis gebunden; jede Zahl muss belegt sein (`numbersBacked`). Zahlen aus der Frage selbst gelten als belegt („Kann man mit 3000 netto …?“).
  - Sie sehen nur ihre Aufgabe und die Ergebnisse ihrer Werkzeuge; den Verlauf (die letzten acht Nachrichten) sieht der Orchestrator (siehe [Korrekturen und Gesprächsverlauf](#korrekturen-und-gesprächsverlauf)).
- **Wann das Modell den Werkzeugtext umformuliert (`converseOn`):**
  - Nicht bei leeren Ergebnissen: „keine Daten“ bleibt der ehrliche Werkzeugsatz statt eines erfundenen Absatzes.
  - Nicht bei Werkzeugen, deren Text schon die Antwort ist (Überblicke, Rückblicke, Hinweise, „Warum …?“-Erklärungen, Was-wäre-wenn, Gehalt), außer bei Rat- und Meinungsfragen oder wenn nur das Modell das Werkzeug geraten hat.
  - Floskeln am Anfang („Kurz gesagt:“, „Du willst wissen …?“) und doppelte Sätze werden entfernt.
- **Kennzeichnung:** Unter jeder Antwort steht nur ein kleiner, zugeklappter Link „Details“ (das Modell als Tooltip, beim Rückfall auf Qwen ein kleiner gelber Punkt); siehe [Details unter der Antwort](#details-unter-der-antwort). Der zuständige Bereich bleibt intern: Er steht als optionales Feld `agent` im Chatverlauf und in der Admin-Ansicht, nicht im Chat.

## Modelle je Aufgabe

Ist ein DeepSeek-Key hinterlegt, wählt `src/lib/ai/client.ts` das Modell nach der Aufgabe des Aufrufs; ohne Key oder bei jedem Ausfall antwortet das lokale Qwen3-8B. Einrichtung, Rückfallregeln und Datenschutz: [local-ai.md](local-ai.md#deepseek-je-aufgabe-qwen-als-rückfall).

| Schritt | Aufgabe | Modell |
| --- | --- | --- |
| Orchestrator-Agent: delegieren, Befunde lesen, Antwort schreiben (Analyse, Zusammenfassung, Bewertung, Recherche, Erklärung, Smalltalk) | Orchestrator | DeepSeek V4 Pro ohne Denkmodus (Stufe im Agent-Repo änderbar; nur DeepSeek, sonst lokaler Rückfall) |
| Spezialisten-Agenten: Werkzeuge wählen, Befunde zurückgeben | Spezialist | DeepSeek Flash (Stufe je Agent im Agent-Repo) |
| Änderung: Details lesen (Buchung, Monatswerte, Regeln, Entwürfe) | Aktion | DeepSeek V4 Pro (ohne Denkmodus) |
| Werkzeug-Hinweise im lokalen Routing | Werkzeugwahl | DeepSeek Flash |
| Freie Antwort nur im lokalen Rückfall und bei kombinierten Fragen | Antwort | DeepSeek Flash bzw. Qwen |
| Antwort aus der Websuche (Websuche der Recherche) | Websuche | DeepSeek Flash |
| 2–3 Folgefragen unter jeder Antwort | Folgefragen | DeepSeek Flash (nur DeepSeek, sonst feste Vorschläge) |
| 👎-Kommentar prüfen: schuldigen Prompt ändern, Nachtest beurteilen | Prüfungs-Agent | DeepSeek V4 Pro (nur DeepSeek; Eval auf Flash) |

Mit DeepSeek entfällt das kleine lokale Router-Modell. Modell-Stufe der Agenten: `agentDefs` in `src/lib/agents/registry.ts`, überschrieben vom Agent-Repo; Aufgaben `orchestrate` und `delegate` in `src/lib/ai/models.ts`.

## Admin-Ansicht

Eine versteckte Seite unter **Einstellungen → „Assistent-Orchestrator“**. Der Link steht dezent unter den Einstellungsbereichen, nicht in der Hauptnavigation; der Pfeil rechts daneben klappt die Unterseiten animiert auf (Motion, `OrchestratorSettingsLinks` in `src/components/orchestrator-nav.tsx`). Kopf mit **Aktualisieren** und eine Unter-Navigation mit gleitender Markierung (auf dem Handy seitlich scrollbar) bleiben beim Wechsel stehen (`layout.tsx`); `/einstellungen/orchestrator` leitet auf die Übersicht um, das frühere `…/aufbau` auf die Topologie.

- **Übersicht** (`…/uebersicht`): Kennzahlen (Agenten, Werkzeuge davon ändernd, Läufe mit Median-Dauer, letzte Gold-Eval, Kosten pro Frage) mit Links zu ihren Seiten, KI-Status mit Warnung bei Rückfall auf Qwen samt Grund, Modell je Aufgabe aus `/api/ai/status`, Kosten pro Frage und je Modell (siehe [Kosten](#kosten)).
- **Topologie** (`…/topologie`): Graph in fünf Spalten – Chat → Orchestrator → Spezialisten, Änderungs-Workflow und lokaler Rückfall → ihre Werkzeuge → Datenquellen –, der Prüfungs-Agent „Im Hintergrund“, Kanten mit Beschriftung (`umsaetze`, `aenderung` …) und Legende. Agenten zeigen Modell-Stufe, ihre Knoten führen zur Agent-Seite, Werkzeuge ins Werkzeug-Repo, Datenquellen in den Katalog. Auf schmalen Bildschirmen dieselbe Struktur als Liste. Reines CSS mit festen Koordinaten, ohne neue Abhängigkeit.
- **Daten** (`…/daten`): der Daten-Katalog – je Datenquelle Körnung, Beschreibung, Felder, Anzahl in der App und welche Agenten sie lesen, dazu ein kleiner Beziehungs-Graph (die gewählte Quelle in der Mitte, verwandte darum, Klick wechselt) und „Weitere Quellen“ (Websuche, Marktdaten, Rechner).
- **Wissen** (`…/wissen`): Wissensdokumente je Agent bearbeiten, neu anlegen und löschen (mit Bestätigung auf der Seite); jede Änderung ist eine Version im Agent-Repo.
- **Läufe** (`…/laeufe`): bis zu 50 Anfragen aus dem Chatverlauf mit Zeit, Agent, Weg, Status, Dauer und Modellen; aufgeklappt der Ablauf als Spur: Orchestrator → Delegationen („Frage Budget & Prognose“ mit Aufgabe) → die Werkzeugaufrufe des Spezialisten mit Ausgang (Symbol plus Text, nie nur Farbe). Ältere Antworten ohne Delegation zeigen ihre Werkzeuge flach.
- **Evals** (`…/evals`): **Gold-Eval starten** (läuft im Hintergrund mit Fortschritt, eine zur Zeit), Verlauf der letzten 30 Läufe mit Auslöser (Admin oder Prüfungs-Agent), Ergebnis, Sicherheitsfehlern, Dauer und den fehlgeschlagenen Fällen.
- **Agenten** (`…/agenten`): Tabelle aller Agenten mit Art, Modell, maximalen Schritten, Zeitlimit, Werkzeugen, Quellen und Repo-Stand („Code“ oder „Bearbeitet v3“); **`…/agenten/<agent>`**: System-Prompt bearbeiten und den zusammengesetzten Prompt ansehen, wie ein Lauf ihn sendet; Modell-Stufe und Limits (in festen Grenzen); Werkzeuge und Datenquellen; Wissen; **Verlauf** aller Versionen mit Autor, Zeit und Notiz; **Zurücksetzen** je Eintrag und **Alles auf Code zurücksetzen**.
- **Werkzeuge** (`…/werkzeuge`): das Werkzeug-Repo, gruppiert nach Delegation und Datenquelle, mit Suchfeld – je Werkzeug Art (Delegation, Workflow, lesend, ändernd), die Agenten, die es aufrufen, und die Beschreibung, die das Modell liest, bearbeitbar mit **Speichern** und **Zurücksetzen**.
- **Feedback & Prüfung** (`…/feedback`): Ort der Feedback-Datei, Zahl der 👍/👎 und Kommentare, die neuesten Einträge und **Herunterladen** (siehe [Feedback-Datei](#feedback-datei-für-copilot)); was der Prüfungs-Agent geändert hat, mit Prompt, Satz, Nachtest, Gold-Eval und Stimmen seit der Änderung; **Zurücknehmen**, **Wieder anwenden** und **Erneut prüfen** (siehe [Prüfungs-Agent](#prüfungs-agent-feedback)).
- **Aktualisieren** lädt die Daten der offenen Unterseite neu. Alle Schreibzugriffe gehen über `/api/agent-repo`, `/api/assistant-evals` und `/api/assistant-rules` (im Kontomodus nur der Administrator, gleiche Herkunft, Rate-Limit).

Dafür speichert jede Antwort im Chatverlauf zusätzlich die optionalen Felder `via` (Regel, Orchestrator, Signal, Modell, Rückfall; ältere Antworten auch Supervisor), `ms` (Dauer), `calls` (höchstens zwölf Werkzeugaufrufe und Delegationen mit `tool`, `ok`, `summary` und `by` (welcher Agent), für die Details auch `args` ≤ 200 und `result` ≤ 400 Zeichen; der Ausgang einer Änderung folgt ihrem `status`), `models` (höchstens acht: Anbieter, Modell, Aufgabe, Rückfall mit Grund, Denkmodus) und `prompt` (System-Prompt der Antwort, gekürzt auf 3.000 Zeichen, nur bei den neuesten 20 Nachrichten). Das ist JSON im bestehenden Verlauf, keine Migration. In die Feedback-Datei gehen von den Aufrufen weiter nur `tool`, `ok` und `summary`.

**Dateien:** `src/lib/assistant/orchestrator-info.ts` (Läufe und Spur), `src/lib/assistant/orchestrator-pages.ts` (Unterseiten), `src/components/orchestrator-admin.tsx` (Shell), `src/components/orchestrator/` (eine Datei je Unterseite, `shared.tsx` für Laden, Speichern und Aktualisieren), `src/components/orchestrator-nav.tsx` (Navigation), `src/app/(dashboard)/einstellungen/orchestrator/` (Layout, Umleitungen, neun Unterseiten und `agenten/[agent]`).

## Feedback-Datei für Copilot

Unter jeder Antwort des Assistenten stehen 👍 und 👎 in der dezenten Aktionsleiste (neben Kopieren und Neu generieren). Jede Bewertung landet sofort in einer einzigen JSON-Datei, mit so viel Kontext, dass man sie direkt an Copilot geben kann, um Probleme zu finden und zu beheben.

- **Bedienung:**
  - 👍 speichert sofort; „Kommentar hinzufügen“ ergänzt optional einen Text.
  - 👎 speichert sofort und öffnet ein kleines Kommentarfeld („Was war nicht gut?“). Enter sendet, Umschalt+Enter macht eine neue Zeile, Escape schließt.
  - Danach zeigen die Leiste „Feedback gespeichert“ und eine kurze Meldung „Feedback gespeichert“ bzw. „Kommentar gespeichert“.
  - Ein späterer Kommentar ergänzt denselben Eintrag (gleiche `id`, `updatedAt`).
  - Auch „Das war falsch“ im Chat zählt als 👎 (auch nach einem 👍) und öffnet das Feld. „Das hat geholfen“ nach einer Web-Antwort zählt als 👍; „Passt“ nach einem 👎 ändert die Bewertung nicht.
  - Escape im Kommentarfeld schließt nur das Feld, nicht den Assistenten.
- **Lernen bleibt:**
  - 👍 lernt die Formulierung wie bisher; bei einer Web-Antwort wird sie gemerkt.
  - 👎 vergisst die Formulierung, notiert die Frage als offen und sperrt eine Web-Antwort samt Quellen. Der Kommentar zu einer Web-Antwort wird zusätzlich als Korrektur-Hinweis gespeichert.
  - Statt einer eigenen Rückfrage im Chat gibt es jetzt das Kommentarfeld. Eine anders formulierte Frage direkt danach (oder „Nein, ich meinte …“) lernt der Assistent weiterhin.
- **Inhalt je Eintrag** (`feedbackEntrySchema` in `src/lib/assistant/feedback.ts`):
  - Zeitstempel (`recordedAt`, `updatedAt`), `rating` (`like`/`dislike`), optionaler `comment` und eine Zeile `summary` zum Überfliegen;
  - die Frage (`question`) und die vollständige Antwort (`answer`): Text, Agent mit Name, Werkzeug, Weg des Orchestrators, KI oder Regel, Dauer, Karte (bis zu 12 Zeilen), Vorschläge, offene Änderung oder Formular und die Werkzeugaufrufe (`calls`);
  - die Live-Status-Schritte der Antwort (`steps`), z. B. „Lese deine Nachricht…“, „Suche aktuelle Informationen…“;
  - `retrieval`: lokales Finanzwissen gesucht und welche Abschnitte genutzt wurden, bestätigte Antwort, Websuche mit Quellen, Marktdaten, Sprachmodell;
  - `context`: bis zu vier Nachrichten vor der Antwort;
  - App-Seite, Stichtag, Bildschirmgröße, Sprache, Farbschema und reduzierte Bewegung;
  - KI-Einstellungen des Servers (Modell, Einbettungsmodell, Websuche);
  - im Kontomodus die Konto-Id, keine Namen.
- **Aufbau der Datei:** Vorne stehen Erklärungen für Copilot (`forCopilot`, `fields`, `privacy`) und die Zahlen (`count`), danach `entries`, älteste zuerst. Höchstens 1.000 Einträge; darüber fallen die ältesten weg. Ist die Datei von Hand kaputt editiert oder zeigt der Pfad auf eine fremde Datei, wird sie nie überschrieben; Speichern meldet dann einen Fehler.
- **Datenschutz:** Der Server entfernt vor dem Speichern aus allen Freitexten IBANs, Karten-, Konto-, Sozialversicherungs- und Telefonnummern, E-Mail-Adressen, Passwörter, Tokens und Schlüssel, auch im Kommentar. Beträge und Händlernamen bleiben, weil sie für die Fehlersuche nötig sind. Die Datei hat die Rechte 0600.
- **Ort:**
  - Entwicklung: `data/assistant-feedback.json`, in `.gitignore`, wird nie committet.
  - Produktion: neben der Kontodatenbank, z. B. `/var/lib/finanzblick/assistant-feedback.json`, weil der App-Ordner dort schreibgeschützt ist.
  - `FINANZBLICK_FEEDBACK_FILE` (absoluter Pfad) legt einen anderen Ort fest; nie unter `public/`.
- **API:** `POST /api/assistant-feedback` schreibt (angemeldet, gleiche Herkunft, höchstens 60 je Minute). `GET` liefert Ort, Zahlen und die neuesten Einträge, `GET ?download=1` die ganze Datei; beides im Kontomodus nur für den Administrator.
- **Nutzung mit Copilot:** Datei unter **Einstellungen → „Assistent-Orchestrator“ → Feedback → Herunterladen** holen und z. B. mit diesem Auftrag übergeben: „Lies assistant-feedback.json. Fang bei den Einträgen mit rating "dislike" an, finde zu jedem die Ursache im Code und behebe sie mit einem Test.“

**Dateien:** `src/lib/assistant/feedback.ts` (Eintrag, Schwärzung, Dateiformat), `src/lib/server/feedback-store.ts` (Ort, Schreiben), `src/app/api/assistant-feedback/route.ts`, `src/components/assistant-chat-parts.tsx` (`MessageActions`, Kommentarfeld), `src/components/finance-assistant.tsx` (Status-Schritte je Antwort, Speichern).

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
| Verträge anlegen (Schritt für Schritt wie im Vertragsdialog) | „Leg einen neuen Vertrag an“, „erstelle vertrag“, „mach mir einen Vertrag für Netflix“, „neuer vertrag disney plus 9,99 monatlich“ → was im Satz steht, wird übernommen; danach Name, Betrag, Kategorie, Kündigungsfrist, Mindestlaufzeit, Rhythmus, nächste Abbuchung, automatische Zuordnung → Vorschau | `contract_create` |
| Vertrag aus Buchungen | „Markiere die Disney Plus Buchung als Vertrag“, „Mach aus der Amazon Buchung einen Vertrag“, „die MediaMarkt Buchung ist ein Vertrag“ → Name, Betrag, Kategorie und nächste Abbuchung aus den Buchungen, die gewählten Buchungen gehören zum Vertrag (wie das Ankreuzen im Assistenten) | `contract_create` mit `bookingIds` |
| Verträge ändern | „Netflix kostet jetzt 15,99 €“, „stell das Intervall von Netflix auf jährlich“, „Hausratversicherung ist vierteljährlich“, „Kündigungsfrist von Magenta ist 3 Monate“, „Vertrag Netflix Kategorie Unterhaltung“, „ändere den Namen von FITINN auf Fitnessstudio“, „Notiz zum Netflix Vertrag: …“, „Bestätige alle Verträge“, „Netflix ist gekündigt zum 31.12.“, „Spotify läuft wieder“, „Verwirf meine Änderungen an Netflix“ | `contract_update`, `contract_action` |
| Verträge löschen | „Lösch den Vertrag Hausratversicherung“ entfernt selbst angelegte Verträge. Erkannte Verträge lassen sich wie im Vertragsordner nicht löschen: „Lösch den Netflix-Vertrag“ blendet ihn mit Erklärung als „kein Vertrag“ aus | `contract_action` (`remove`, `ignore`) |
| Buchungen einem Vertrag zuordnen | „Ordne die Buchung vom 2.10. dem Vertrag Disney Plus zu“, „Verknüpfe die MediaMarkt Buchung mit dem Hausrat Vertrag“, „Nimm die Buchung vom 5.10. aus dem Netflix-Vertrag“; gibt es den Vertrag nicht, bietet er „Als Vertrag markieren“ an | `contract_bookings` |
| Buchungen | „Lösch die Buchung vom 24.10.“ (eine benannte, höchstens 10), „Notiz zur MediaMarkt Buchung: Fernseher fürs Wohnzimmer“, „Lösch die Notiz bei der MediaMarkt Buchung“ (löscht nie die Buchung), „Tagge die Pizzeria-Buchungen mit Essen gehen“, „Teil die Buchung vom 11.10. mit Raphael“, „ändere die Kategorie der Pizzeria Buchung auf Lieferdienste“, „Die Amazon Buchung vom 14.10. ist Haushalt“, „nenn SHELL 1234 WIEN ab jetzt Shell“, ignorieren, aus dem Plan nehmen, als geprüft markieren | `transaction_delete`, `transaction_tag`, `transaction_update` (auch `note`), `categorize` |
| Sparziele (Schritt für Schritt wie im Zieldialog) | „Ich möchte ein Sparziel anlegen“ → Name, Betrag, Datum oder Monatsrate, Startkapital, Konto → Vorschau mit „Anlegen“; „spar monatlich 300 für das Motorrad“, „Das Sparziel Motorrad soll auf dem Sparkonto liegen“, „Im Jänner 200 € extra vom Sparkonto fürs Motorrad“, umbenennen, aussetzen, erreicht, löschen | `goal_update` (auch `pocket`), `goal_extras`, `goal_pause`, `goal_complete`, `goal_delete` |
| Budgets | „Ändere das Lebensmittelbudget auf 400 €“, „lebensmittel budget 450“, „erhöh das Tankbudget um 40“, „schichte 30 € von Tanken zu Restaurants um“, „verschiebe 10 € von Freizeit nach Essen“, „setz das Tankbudget zurück“; negative Beträge, zu große Umschichtungen und unbekannte Budgets („Budget für Einhörner“) lehnt er mit Begründung ab | `budget_plan` |
| Monatsplan-Positionen | „neue Budgetzeile Haustier 40 € monatlich“, „Benenne die Position Geschenke in Weihnachten um“, „Die Position Geschenke gehört zur Kategorie Geschenke & Spenden“, „Mach die Position Geschenke zu Fixkosten“, „Setze Geschenke im Dezember auf 300 €“, „verschiebe 100 € von Geschenke zu Urlaub im Dezember“, „Lösche die Position Geschenke“; „Miete im Dezember 700“ ohne solche Position bietet das Anlegen an | `plan_row_save`, `plan_row_delete`, `plan_value` |
| Gehalt & Steuern | „Prüf meine Lohnabrechnungen“ (zurückgehaltene Abrechnungen mit Grund, offene Budgetwerte), „Übernimm die Abrechnung September ins Budget“, „Lösch die Abrechnung März 2026“ (PDF und Kontoumsätze bleiben), „Aktualisiere das Budget mit den Lohnzetteln“, „Übernimm/Behalte die Budgetwerte zur Prüfung“, „Setz den Successbonus auf 15 %“ | `payslip_confirm`, `payslip_remove`, `payroll_sync`, `bonus_percent` |
| Einstellungen (App-Daten, mit Vorschau) | „Stell das Design auf Weihnachten“, „Design wieder automatisch nach Jahreszeit“, „Schalte das Nachschlagen unbekannter Abrechnungsbegriffe aus“, „Setz den Notgroschen auf 6000 €“ | `seasonal_theme`, `setting_flag`, `setting` |
| Einstellungen dieses Geräts (sofort) | „Dunkelmodus an“, „mach es hell“, „Benachrichtigungen an/aus“ (ohne Browser-Erlaubnis: Link zu den Einstellungen), „Mach die Töne aus“, „Sichtschutz an“, „Beträge wieder anzeigen“ | – |
| Konten | „Das Girokonto ist für alle Ausgaben“, „Lösch die Kontoregel für Girokonto“ | `account_rule`, `account_rule_delete` |
| Nur als Link oder Erklärung | Bank- und Google-Anmeldung, Datei-Uploads, Backups; der Stichtag läuft automatisch mit | – |

Mehrere Änderungen gleicher Art in einer Nachricht („Erhöhe Tanken um 20 und senke Freizeit um 10“) kommen in eine Vorschau. Ein Teil, der schon so ist („… ist schon Shopping“), wird gesagt statt als Fehler gemeldet. Eine zweite Änderung anderer Art („Leg einen Vertrag für Netflix an und lösch die Position Geschenke“) geht nicht mehr verloren: Der Assistent erledigt den ersten Teil und bietet den zweiten als Knopf an (`secondChange`).

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

## Chat-Test 4: alle Aktionen (12.11.2026)

Zuerst wurden alle Aktionen der Seiten (Übersicht, Umsätze, Verträge, Budget, Sparen, Gehalt & Steuern, Einstellungen) mit den Operationen des Assistenten verglichen. Was fehlte, kam dazu: Buchungsnotizen, Buchungen einem Vertrag zuordnen, Vertrag aus einer Buchung, Konto eines Sparziels, Umschichten zwischen Positionen, Lohnabrechnungen übernehmen, entfernen und Budget nachziehen, Design und Begriffserklärung, Geräte-Einstellungen.

Getestet wurde zweistufig:

- **Matrix-Test** (`all-actions.test.ts`, 197 Fälle): jede Formulierung wird geroutet, als Vorschau gebaut, wie mit „Bestätigen“ angewendet, durch dieselbe Plan-Synchronisierung wie im Provider geschickt und wieder rückgängig gemacht. Geprüft werden Daten, Gültigkeit und dass Rückgängig den alten Stand herstellt. Dazu kommen Grenzfälle: ungültige und negative Beträge, fehlende Angaben, doppelte Namen, nicht vorhandene Verträge, Ziele, Positionen und Buchungen.
- **Live im Browser** mit lokalem Qwen3-8B und synthetischen Daten: 247 Nachrichten (168 verschiedene) in vier Läufen, dazu 99 Klicks auf „Bestätigen“, Antwort-Knöpfe oder „Rückgängig machen“ und 73 Prüfungen des gespeicherten Stands (App-Daten und Geräte-Einstellungen). Nur eine Antwort brauchte das Modell; der Median bis zur fertigen Antwort lag bei 1,5 s. Seiten- oder Konsolenfehler traten in den Läufen mit Fehlerprotokoll nicht auf.

| Problem | Ursache | Korrektur |
|---|---|---|
| „Lösch die Notiz bei der MediaMarkt Buchung“ hätte die **Buchung gelöscht** | Lösch-Erkennung kannte keine Notizen | Notizen als eigene Aktion; „Lösch … Notiz/Tag/Kategorie“ löscht nie die Buchung |
| „verschiebe 50 € von Freizeit nach Essen“ setzte Freizeit auf 50 € | „Essen“ war kein Budget, ein einzelnes Budget fiel auf „auf 50“ zurück | „Essen“ meint Lebensmittel; Umschichten nur zwischen zwei Budgets, sonst ehrliche Antwort |
| „lebensmittelbudget auf -50 setzen“ setzte 50 €, „Sparziel … -500 €“ nahm 500 € | Minuszeichen ging verloren | Negative Beträge werden abgelehnt bzw. neu erfragt |
| Nach „Welches meinst du? … Vespa“ wurde „Vespa ist erreicht“ zum **Löschen** von Vespa und als Alias gelernt | Jede Nachricht mit dem Namen galt als Auswahl | Ein eigener Befehl ist keine Auswahl; nur der bloße Name zählt |
| „Nein“ und dann „Ja“ unter der Vertragsvorschau: „nicht verstanden“, nichts gespeichert | Nach einer unklaren Antwort fehlte die Vorschau | Vorschau bleibt bestätigbar; „Nein“ fragt, was geändert werden soll |
| „Setz Tanken im Dezember auf 150 €“ und „neue Budgetzeile Haustier“ schienen gespeichert, verschwanden aber | Budgets gelten für jeden Monat gleich; die App berechnet variable Zeilen nach jeder Änderung neu (`applyVariableBudgets`) | Ehrliche Antwort mit Knopf „Budget ab sofort setzen“; neue Positionen sind wie im Dialog Einnahme oder Fixkosten; die Operation lehnt solche Werte ab |
| „Setz Urlaub im Dezember auf 300 €“ änderte das Urlaubs-Ziel | Einstellungswort vor Monatsplan | Eine genannte Position mit Monat geht vor |
| „Sparziel Urlaub …“ während eines offenen Ziels benannte das offene Ziel um | Gleiche Aktion galt als Fortsetzung | Ein anderer Zielname startet ein neues Ziel |
| „Sichtschutz an“ meldete „Erledigt“, obwohl der Sichtschutz in den Einstellungen aus ist | Umschalten ohne Rückmeldung | Ehrlicher Hinweis auf die Einstellung |
| „Benachrichtigungen bitte ausschalten“, „Töne an“ wurden als Name einer geplanten Ausgabe gelesen | Offener Entwurf nahm jede Nachricht | Befehle und Geräte-Einstellungen verlassen den Entwurf |
| „Lösch den Netflix-Vertrag“ endete mit einer Fehlermeldung | Erkannte Verträge sind nicht löschbar | Vorschau „ausblenden (kein Vertrag)“ mit Erklärung |
| Intervall, Name, Kategorie eines Vertrags; „Hausratversicherung ist vierteljährlich“; „spotify läuft doch wieder“; „netflix is gekündigt“; „mach den … Vertrag weg“ | Fehlende Formulierungen, Komposita | Vertragsänderungen erkannt |
| „Ordne die Buchung … dem Vertrag … zu“, „Markiere die Disney Plus Buchung als Vertrag“ | Nicht vorhanden | `contract_bookings`, Vertrag aus Buchungen |
| „Kategorie der Lieferando-Buchungen auf Restaurants“ blieb Lieferdienste | Kategoriegruppe und Hinweis des Modells gingen vor | Das Wort des Nutzers gewinnt |
| „schreib zur billa grosseinkauf buchung dazu …“ fand alle Billa-Buchungen | Hinweis des Modells („Billa“) vor dem genaueren Text | Der genauere Händlername aus dem Text gewinnt |
| „Ignoriere die Amazon Gutschrift“ → Rückerstattungen | Wort „Gutschrift“ | Befehle an Buchungen gehen vor |
| Lohnabrechnungen prüfen, übernehmen, entfernen, Budget aktualisieren → nur Übersicht | Nicht vorhanden | `payslip_confirm`, `payslip_remove`, `payroll_sync`, Prüfbericht |
| Design, Begriffserklärung, Benachrichtigungen, Töne, Sichtschutz, Stichtag → keine Aktion | Nicht vorhanden | Siehe Tabelle „Aktionen im Chat“ |
| „Leg einen Vertrag … an und lösch die Position …“ verlor den zweiten Teil | Zwei Änderungen verschiedener Art | Zweiter Teil kommt als Knopf |
| Aus dem Code-Review: „Lösch die Buchung Nebenkostenabrechnung“ → Lohnabrechnung löschen, „Thema ETF“ → Design, „Ich bekomme keine Benachrichtigungen“ schaltete sie aus, „Halloween-Design ausschalten“ schaltete es ein, „Das monatliche Netflix-Abo ist gekündigt“ → Intervall, „Nimm die Buchung in den Vertrag auf“ → entfernen, „Tankbudget minus 30 €“ abgelehnt, „Nenn mir einfach …“ → Umbenennen; ganze Sätze im Vertragsdialog verließen ihn | Zu weite Wortmuster | Engere Muster, Statusänderung vor Intervall, Umschalten nur mit klarem Befehl, Antworten im Entwurf bleiben im Entwurf; Rückgängig stellt bei Konto „Motorrad“ auch Ziel und Datum des Motorrads wieder her |

Weiter offen: Tippfehler in Namen („spotfy“) beantwortet der Assistent mit einer Rückfrage samt Auswahl statt zu raten. Neue Fixkosten-Buchungen stehen bis zur Prüfung in der Prüfliste und sind bis dahin kein Vertrag (bestehendes Verhalten). Antworten, die den Server nach Hinweisen fragen, brauchen weiter bis zu ~12 s (90. Perzentil 11 s). Eine Antwort blieb im ersten Lauf während eines Code-Neuladens leer; sie war nicht wiederholbar.

`npm run eval:assistant` blieb unverändert: 107/108 goldene, 22/22 grenzwertige Fragen, alle Prompt-Injection-Tests bestanden.

## Live-Status und Chat-Oberfläche

Der Chat wirkt wie ein Gespräch, nicht wie ein Protokoll. Während eine Antwort entsteht, stehen an der Stelle des Bots nur der Denk-Orb und daneben ein, zwei Wörter („Suche…“, „Rechne…“, „Schreibe…“) – ohne Rahmen, Werkzeug-Chips oder Modellnamen. Sobald Wörter kommen, steht nur noch die Antwort in ihrer Blase. Ist sie fertig, verschwindet der Orb, und der Droide übernimmt. Die Effekte stammen aus den Libraries.dev-Paketen `thinking-orbs`, `bot-avatars`, `border-beam` und `metal-fx`.

- **Status je Schritt** (`src/lib/assistant/status.ts`):
  - „Lese deine Nachricht…“, dann „Verstehe deine Frage…“, während der Orchestrator entscheidet. Kennen die Regeln den Spezialisten schon, erscheint sein Schritt sofort, auch während der Server noch Details liest;
  - danach je Werkzeug, z. B. „Analysiere deine Buchungen…“, „Prüfe deine Verträge…“, „Berechne dein freies Budget…“, „Lese deine Lohnabrechnungen…“, „Suche passendes Wissen…“, „Hole aktuelle Marktdaten…“;
  - „Formuliere die Antwort…“ während des Streamings, „Denke gründlich nach…“, solange der Denkmodus läuft.
  - Diese Schritt-Texte bleiben intern (Feedback-Datei); der Chat zeigt nur die Kurzform je Art der Arbeit (`shortStatus`): „Lese…“, „Überlege…“, „Suche…“, „Analysiere…“, „Rechne…“, „Bereite vor…“, „Fasse zusammen…“, „Schreibe…“, dazu „Denke nach…“, „Suche im Web…“ und „Vergleiche…“. Ein sanfter Lichtschimmer läuft über den Text (`.assistant-shimmer`), bei reduzierter Bewegung steht er still.
  - Welches Modell antwortet, steht nicht mehr im Live-Status, sondern in den Details. Der Server meldet zuerst den System-Prompt (`{"prompt": …}`) und dann das Modell (`{"model": …}`), sobald es die Anfrage angenommen hat.
  - Ein Test stellt sicher, dass jedes Werkzeug einen Status hat.
- **Denk-Orb** (`ThinkingOrb`, 32 px an der Stelle des Bots): Jeder Schritt trägt eine Art von Arbeit, die die Animation wählt:

  | Art | Orb | Beispiele |
  |---|---|---|
  | Nachricht lesen | `listening` | „Lese deine Nachricht…“ |
  | Orchestrator entscheidet | `connecting` | „Verstehe deine Frage…“ |
  | Suchen | `searching` | „Suche passendes Wissen…“, „Hole aktuelle Marktdaten…“, „Suche Rückerstattungen…“ |
  | Daten durchgehen | `working` | „Analysiere deine Buchungen…“, „Prüfe deine Verträge…“ |
  | Rechnen | `solving` | „Berechne dein freies Budget…“, „Lese deine Lohnabrechnungen…“ |
  | Änderung vorbereiten | `shaping` | „Bereite die Änderung vor…“, „Bereite den Vertrag vor…“ |
  | Überblick zusammenstellen | `weaving` | „Stelle deinen Überblick zusammen…“ |
  | Antwort schreiben | `composing` | „Formuliere die Antwort…“ |

  Orb und Text wechseln mit einer kurzen Feder aus leichter Unschärfe. Der Orb ist Dekoration (`aria-hidden`); vorgelesen wird der Text.
- **Nur der Droide** (`BotAvatar` Typ `droid`, `DroidAvatar`): Seit dem 15.11.2026 hat der Assistent ein einziges Gesicht; Stern, Blume, Kleeblatt und Mech sind entfallen, und welcher Spezialist gearbeitet hat, steht weder am Bot noch unter der Antwort.

  Während eine Antwort entsteht, ist kein Bot zu sehen, nur der Orb. Ist sie fertig, schrumpft der Orb mit leichter Unschärfe weg, und der Droide federt an seine Stelle. Eine gestreamte Antwort bleibt dabei stehen, nur das Bild wechselt. Zustände: `default` schaut sich bei der neuesten Antwort um, `working` im leeren Chat, solange man auf eine Startfrage zeigt. Ältere Antworten behalten ihre Pose ohne Animation, damit ein langer Verlauf keine Bilder mehr kostet. Im Verlauf ist der Droide Dekoration; im leeren Chat heißt er „Finanz-Assistent“.
- **BorderBeam:** ein langsam atmender Rand (`pulse-inner`, Palette `forest` passend zum Mint der App) um die neueste Änderung oder Vorschau, die auf „Bestätigen“ wartet. Nach der Entscheidung blendet er aus. Die laufende Antwort hat seit dem 15.11.2026 keinen Rahmen mehr.
- **MetalFx:** ein feiner Flüssigmetall-Ring (`circle`, `silver`) um Senden und Stopp, solange der Knopf etwas tun kann. Er liegt als eigene Ebene hinter dem Knopf: Der Knopf selbst hängt nie von WebGL ab und bleibt auch ohne den Effekt sichtbar und bedienbar.
- **Nachrichten:** neue Nachrichten federn herein (Feder 300/28, leichte Skalierung und Verschiebung, eigene von rechts). Gestreamte Wörter blenden einzeln aus einer leichten Unschärfe ein (CSS, nur `opacity` und `filter`).
- **Aktionen unter Antworten:** Kopieren (mit „Kopiert“ für Screenreader), Neu generieren (nur bei der letzten KI-Antwort), Hilfreich/Nicht hilfreich. Ältere Antworten zeigen die Leiste auf Geräten mit Maus erst bei Hover oder Fokus.
- **Eingabe:** wächst mit dem Text (`field-sizing: content`, höchstens 12 Zeilen). Enter sendet, Shift+Enter bricht um, und während einer IME-Eingabe sendet Enter nicht. Die eigene Frage erscheint sofort, noch bevor Routing und Werkzeuge laufen. Während der Antwort bleibt das Feld bedienbar: Man kann die nächste Frage schon tippen, Enter schickt sie aber erst, wenn die Antwort fertig ist. Senden wird zu **Stopp**: Die Anfrage wird sofort abgebrochen, schon gestreamter Text bleibt mit „…“ stehen und lässt sich neu generieren.
- **Leerer Chat:** der Droide (64 px), Begrüßung „Wobei kann ich dir helfen?“ mit drei Vorschlägen („Was habe ich diesen Monat ausgegeben?“, „Zeige mir meine Verträge“, „Wie viel ist noch frei?“). Bis zur ersten Frage bleibt die Begrüßung im Blick; danach scrollt der Chat zur neuesten Nachricht.
- **Weniger Bewegung:** Mit `prefers-reduced-motion` oder der Einstellung in der App gibt es nur kurze Überblendungen: Orb und Bots stehen still, BorderBeam und Metall-Ring sind aus. Alle eigenen Animationen nutzen nur `transform`, `opacity` und `filter`; Orb, Bots und Metall-Ring zeichnen auf Canvas bzw. WebGL und pausieren außerhalb des sichtbaren Bereichs.
- **Hell und Dunkel:** Orb und Bots erkennen die `dark`-Klasse selbst; BorderBeam und MetalFx bekommen das Farbschema der App, weil sie sonst nur dem System folgen würden.
- **Laden:** Der Chat wird erst beim Öffnen geladen (`next/dynamic`), die vier Pakete also auch.
- **Flüssig auch mit großem Haushaltsbuch:** Während einer Antwort ändert der Chat den globalen Finanzstand nicht. Frage, Antwort und Gelerntes sammeln sich lokal und gehen gesammelt in den Finanzstand, sobald der Chat ruhig ist (spätestens beim Schließen oder Verlassen der Seite). Status und gestreamte Wörter rendern nur die laufende Zeile, höchstens einmal pro Bild. Details und Messwerte: [PERFORMANCE.md](PERFORMANCE.md#finanz-assistent-flüssiger-chat-november-2026).

**Dateien:** `src/components/assistant-chat-parts.tsx` (Droide, Orb, Übergabe Orb → Droide, laufende Antwort mit eigenem Live-Speicher, Statuszeile, Rahmen, Streaming-Text, Einblenden, leerer Chat, Aktionen, Senden/Stopp), `src/lib/assistant-state.ts` (welche Änderungen nur den Assistenten betreffen), `src/lib/assistant/status.ts` (Text, Art der Arbeit und Agent je Schritt), `src/components/finance-assistant.tsx` (Ablauf, Abbruch, Neu generieren), `src/app/globals.css` (`.assistant-word`, `.assistant-shimmer`).

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

## Freie Formulierungen, Websuche und Selbstlernen

Fragen und Aufträge funktionieren unabhängig von der genauen Formulierung. Bei Unsicherheit oder aktuellen Finanzfragen sucht der Assistent selbst im Internet, vergleicht die Quellen und lernt aus deinem Feedback.

**Freie Formulierungen** (`src/lib/assistant/intents.ts`):

- Eine Aktion und ein Thema, in beliebiger Reihenfolge und Form, ergeben ein Werkzeug. „erstelle vertrag“, „mach mir einen Vertrag“, „ich brauche einen neuen Vertrag“ und „Netflix als Abo speichern“ starten alle den Vertragsdialog.
- Gleiches gilt für Sparziele („neues Ziel: Notgroschen 3000“), Budget („budget status“, „hab ich mein budget überzogen“), Umsätze („nur ausgaben im oktober“, „alle zahlungen an spotify“) und Gehalt („was bekomm ich raus“, „meine letzte abrechnung“).
- Kleine Tippfehler im Thema werden toleriert („erstelle vertarg“, „zeig mir mein gehlat“).
- Die bestehenden Regeln entscheiden weiter, wenn sie die Anfrage kennen. Die Rahmen füllen nur Lücken und korrigieren bekannte Fehlgriffe:
  - eine Lohnabrechnung wird nicht als geplante Ausgabe gelesen;
  - „Budget-Status“ ist nicht der Wochenüberblick;
  - ein öffentlicher Grenzwert („Geringfügigkeitsgrenze 2026 – wie viel ist das?“) ist keine Umsatzfrage.
- Definitions-, Rat- und Wie-Fragen („Was ist ein Budget?“, „Wie lege ich einen Vertrag an?“) und allgemeine „man“-Fragen bleiben bei ihren eigenen Wegen.
- Was Regeln und Rahmen nicht erkennen, entscheidet wie bisher das Modell: ein Ein-Wort-Aufruf für den Agenten, dann die Werkzeugwahl des Spezialisten.
- Ergebnis ohne Modell: 59/59 Varianten statt vorher 37/59. Mit Modell: 107/108 goldene und 22/22 grenzwertige Fragen, wie vorher; nur Regeln jetzt 103/108.

**Natürliches Gespräch:**

- Versteht der Assistent eine Nachricht nicht, fragt er mit den naheliegenden Optionen nach („Geht es dir um dein Gehalt oder dein Budget?“ mit Antippen-Vorschlägen), statt abzulehnen. Die neue Formulierung lernt er wie bisher.
- Mehrere Absichten in einer Nachricht: „Zeig mir mein Budget und leg einen Vertrag für Netflix an“ oder „Neuer Vertrag für Spotify, außerdem: was verdiene ich?“ Er beantwortet zuerst die Fragen und startet danach den Vertrags- oder Sparziel-Dialog. Zwei Dialoge auf einmal oder eine direkte Änderung in einer kombinierten Nachricht teilt er nicht.

**Automatische Websuche** (`src/lib/web/search.ts`, `POST /api/ai/web-search`):

- **Wann:** Der Orchestrator entscheidet (`wantsWebSearch`):
  - immer bei „Such im Internet nach …“ oder „google mal …“;
  - immer bei aktuellen Werten (Kurse, Preise, Zinsen, Steuersätze, Nachrichten), siehe [Aktuelle Werte](#aktuelle-werte-datenüberblick-und-freie-werkzeugwahl);
  - bei öffentlichen Beträgen und Regeln, die sich jährlich ändern (Grenzen, Pauschalen, Absetzbeträge, Beihilfen, Förderungen, Boni, Mindestlohn, Pension …), wenn das lokale Wissen sie nicht sicher kennt oder ein Jahr genannt ist;
  - bei allgemeinen Finanzfragen ohne Treffer im lokalen Wissen;
  - einmal nachträglich, wenn die freie Antwort zugibt, es nicht zu wissen.
- **Wann nicht:** App-Aktionen, Werkzeuge mit eigenen Daten, Fragen zu den eigenen Zahlen, kreative und fachfremde Anfragen. Normale Aktionen warten nie auf das Internet.
- **Datenschutz:** Ins Internet gehen nur Suchwörter. Beträge, lange Zahlen, E-Mail-Adressen, IBANs und Links werden vorher entfernt; ohne Landesangabe wird „Österreich“ angehängt.
- **Quellen:**
  - Standard ist DuckDuckGo (HTML-Ergebnisse), danach Bing; optional ein eigenes SearXNG (`FINANZBLICK_SEARXNG_URL`) oder die Brave-Search-API (`BRAVE_SEARCH_API_KEY`);
  - ein Anbieter zählt nur, wenn mindestens ein Treffer ein Themenwort der Frage enthält; sonst ist der nächste dran;
  - Wikipedia ergänzt, wenn weniger als drei Seiten brauchbar sind;
  - amtliche Seiten (`.gv.at`, Arbeiterkammer, WKO, Sozialversicherung, AMS …) zuerst; soziale Netzwerke, Shops und PDFs nie.
- **Seiten lesen:**
  - nur https;
  - Hosts, die auf private oder lokale Adressen zeigen, werden per DNS-Prüfung abgewiesen;
  - Weiterleitungen werden einzeln geprüft;
  - höchstens 256 KB je Seite, 4,5 s je Seite.
- **Passagen:** Aus jeder Seite kommen die zwei passendsten Absätze, Sätze mit Beträgen zuerst; bei Betragsfragen auch eine Betragstabelle. Absätze zum gefragten Jahr gehen vor, ältere Jahre zählen weniger. Menüs, Fußzeilen und Cookie-Texte fallen weg, versteckte Anweisungen werden entfernt.
- **Vergleich:** Höchstens drei nummerierte Quellen mit je etwa 460 Zeichen. Beträge, die mindestens zwei Quellen nennen, stehen als „übereinstimmend“ in der Evidenz. Das Modell soll Übereinstimmungen direkt sagen, Widersprüche mit beiden Angaben nennen, amtliche Quellen vorziehen und mit [1], [2] verweisen. Jede Zahl der Antwort muss in den Quellen stehen (bestehende Belegprüfung).
- **Ohne Modell:** Es antwortet die amtlichste Quelle in eigenen Worten, mit Quellennummer und Hinweis.
- **Anzeige:**
  - Orb im Zustand `searching` mit „Suche aktuelle Informationen…“, danach „Vergleiche Quellen…“;
  - unter der Antwort „Quellen: [1] oesterreich.gv.at [2] …“ als Links (neuer Tab, nur https).
- **Geschwindigkeit:** Suche 0,3–1,3 s, Seiten parallel; Ergebnisse 6 Stunden im Speicher. `FINANZBLICK_WEB_SEARCH=off` schaltet die Websuche ab.

**Selbstlernen** (`src/lib/assistant/web-learning.ts`, siehe auch [Lokales Wissen aus Antworten](#lokales-wissen-aus-antworten)):

- **Jede Web-Antwort** wird sofort als lokales Wissen gespeichert (`assistantKnowledge`, Art `web`, noch ohne 👍), mit Ablaufdatum, wenn sich der Inhalt ändern kann. **👍 oder „Das hat geholfen“** bestätigt sie. Ab dann:
  - Dieselbe Frage in anderen Worten beantwortet er sofort aus dem Gedächtnis, ohne Routing, Suche oder Modell („Von dir bestätigt“; unbestätigt nur bei derselben Frage, „Lokal gemerkt“).
  - Ähnliche Fragen durchsuchen bestätigte Antworten zusammen mit dem lokalen Finanzwissen. Die Antworten werden einmal eingebettet, per Inhalts-Hash in `sqlite-vec` gehalten und nur mit den Einträgen der jeweiligen Anfrage verglichen; ohne Einbettungsmodell zählt die Wortüberschneidung.
  - Jede Bestätigung und jede Wiederverwendung rückt eine Antwort ein wenig nach vorne, höchstens um 0,06. Beim Aufräumen des Gedächtnisses bleiben bestätigte und oft genutzte Antworten am längsten.
- **👎** markiert die Antwort als abgelehnt: Sie wird nie wieder vorgeschlagen, und ihre Quellen lässt die nächste Suche zu dieser Frage weg. Im Kommentarfeld unter der Antwort kann man sagen, was nicht stimmt. Diese Korrektur speichert er als Hinweis und gibt sie künftigen Antworten zu dieser Frage mit.
- Alles liegt im bestehenden JSON-Finanzstand mit optionalen Feldern; die Datenbankstruktur bleibt unverändert. Unter „Gedächtnis“ ist jeder Eintrag sichtbar und löschbar.

**Dateien:** `src/lib/assistant/intents.ts`, `src/lib/assistant/public-facts.ts`, `src/lib/assistant/web-learning.ts`, `src/lib/assistant/combined.ts`, `src/lib/web/search.ts`, `src/lib/web/web-answer.ts`, `src/app/api/ai/web-search/route.ts`, `src/lib/knowledge-base/` (gelernte Treffer), `src/components/finance-assistant.tsx`.

## Lokales Wissen aus Antworten

Was der Assistent allgemein beantwortet, merkt er sich lokal und fragt beim nächsten ähnlichen Fall zuerst sein Gedächtnis, bevor er DeepSeek oder das Internet fragt (`src/lib/assistant/answer-memory.ts`, `rememberAnswer` in `web-learning.ts`).

- **Was gespeichert wird:** freie Antworten des allgemeinen Chats, die ohne persönliche Fakten entstanden sind (etwa „Worauf sollte man beim Goldkauf achten?“), und jede Antwort der Websuche. Sie landen sofort als Eintrag `answer` bzw. `web` mit 0 Stimmen in `assistantKnowledge` (höchstens 200 Einträge, JSON im Finanzstand, keine Migration) und sind unter „Gedächtnis“ sichtbar und löschbar.
- **Was nie gespeichert wird:**
  - Antworten mit den Zahlen oder der Lage des Nutzers (Spezialisten, persönliche Fakten im allgemeinen Chat) und Fragen mit „ich/mein/mir“;
  - Texte mit IBAN, Karten-, Telefon- oder langen Kontonummern, E-Mail-Adressen, Schlüsseln oder Platzhaltern der Pseudonymisierung (`redactSensitive`);
  - Antworten, die zugeben, es nicht zu wissen;
  - Nachrichten, Kurse und jede Frage nach einem aktuellen Wert („Was kostet Diesel gerade?“, „Wie hoch ist die KESt 2026?“), siehe [Aktuelle Werte](#aktuelle-werte-datenüberblick-und-freie-werkzeugwahl).
- **Ablaufdatum** (`volatility`): Zinsen, Inflation und Preise gelten 7 Tage; jährliche Grenzwerte, Pauschalen, Absetzbeträge und Steuersätze bis zum Jahresende (bei „2027“ bis Ende 2027). Abgelaufene Einträge werden nicht mehr gefunden und beim nächsten Speichern entfernt. Erklärungen („Was ist ein Wechselkurs?“) bleiben.
- **Zuerst lokal:**
  - Vor dem Routing: dieselbe Frage (beide Richtungen mindestens 85 % gleiche Wörter, bestätigte Antworten ab 80 %) wird sofort aus dem Gedächtnis beantwortet, ohne Modell („Lokal gemerkt“ bzw. „Von dir bestätigt“).
  - Nach dem Routing: Für Fragen des allgemeinen Chats sucht er die gespeicherten Antworten zusammen mit dem Finanzwissen (Vektor und Stichwort). Ein unbestätigter Treffer antwortet allein nur bei Abstand ≤ 0,38, ein bestätigter wie bisher bei ≤ 0,45; sonst geht der Treffer als Evidenz in die Antwort.
- **Priorität:** 👍 hebt eine Antwort an (Bonus bis 0,06 im Abstand, länger behalten beim Aufräumen), 👎 sperrt sie; ein Kommentar dazu wird als Hinweis gespeichert. Eine gesperrte Antwort wird nicht stillschweigend überschrieben, erst ein 👍 holt sie zurück.
- **Vektordatenbank:** Die Einbettungen gespeicherter Antworten (Qwen3-Embedding, lokal) liegen dauerhaft in einer sqlite-vec-Datei (`data/assistant-knowledge.sqlite`, in Produktion neben der Datenbank, `FINANZBLICK_KNOWLEDGE_VECTORS`), nur Inhalts-Hash und Vektor, nie der Text. Neue Antworten werden in Paketen zu 16 eingebettet, höchstens 2,5 s pro Frage; ohne Einbettungsmodell zählt die Wortüberschneidung. Embeddings und Wissen gehen nie an DeepSeek.

## Folgefragen von DeepSeek

Unter jeder fertigen Antwort stehen 2–3 Folgefragen, die DeepSeek Flash passend zur Frage, zur Antwort und zu den letzten Fragen schreibt (`src/lib/ai/follow-ups.ts`, `POST /api/ai/follow-ups`).

- **Ablauf:** Die Antwort zeigt zuerst die festen Vorschläge des Werkzeugs. Nach dem Lauf lädt der Chat die Folgefragen im Hintergrund (etwa 1 s, rund 300 Token) und ersetzt die festen, solange die Antwort die neueste ist. Eine neue Frage bricht das Laden ab. Die Gruppe heißt dann „Vorschläge von DeepSeek“; ein Klick stellt die Frage.
- **Nicht bei** Formularen, Vorschauen, Rückfragen mit Optionen, gestoppten oder fehlgeschlagenen Antworten.
- **Prüfung:** nur Fragen oder harmlose Bitten („Zeig mir …“, „Erklär …“), 8–90 Zeichen, nichts schon Gefragtes, keine Lösch-, Überweisungs- oder Passwort-Wörter, keine Links, Kontonummern, Platzhalter oder versteckten Anweisungen. Bleiben weniger als zwei, gelten die festen Vorschläge.
- **Beim Thema:** Der Prompt verlangt denselben Gegenstand (Bitcoin, Netflix, Lebensmittel …), keinen Themenwechsel und nichts, was die Antwort schon beantwortet; gut sind Entwicklung, Vergleich, Bezug zu den eigenen Finanzen oder der nächste Schritt in der App. Danach muss jede Frage einen Wortstamm mit Frage oder Antwort teilen (`src/lib/assistant/follow-up-topics.ts`; Kurs, Preis und Wert gelten als gleich, Zeitwörter zählen nicht). Fremde Vorschläge fallen weg.
- **Ohne DeepSeek** (kein Key, Pause, Fehler) gelten feste Vorschläge zum selben Thema (`topicFollowUps`: nach einem Kurs etwa „Wie hat sich Bitcoin in den letzten 30 Tagen entwickelt?“), sonst die des Werkzeugs; das lokale Modell wird dafür nie gefragt. Nach einer Web-Antwort steht „Das hat geholfen“ immer zuerst. Das Modell steht in „Letzte Läufe“ (Aufgabe „Folgefragen“).

## Aktuelle Werte, Datenüberblick und freie Werkzeugwahl

Der Assistent arbeitet freier: Aktuelle Werte holt er immer frisch aus dem Internet, er sieht einen Überblick über alle App-Daten und entscheidet selbst, was er zusätzlich nachschlägt. Ändern tut er weiter nur nach Bestätigung.

**Aktuelle Werte** (`src/lib/assistant/current-info.ts`, `src/lib/web/live-data.ts`):

- **Erkennung ohne Modell:** `currentInfo` unterscheidet Kurs (Bitcoin, Gold, DAX, „…aktie“ mit Kurs-, Preis- oder Jetzt-Wort), Nachrichten („Was gibt es Neues an der Börse?“) und – mit einem Jetzt-Wort wie „aktuell“, „heute“, „gerade“ oder einer Jahreszahl – Steuersätze und Grenzwerte, Zinsen und Preise. Fragen nach den eigenen Zahlen („mein Depot“) und Erklärungen („Was ist ein ETF?“) zählen nicht.
- **Immer Web:** Bei einem aktuellen Wert überspringt der Chat das lokale Wissen und das Gedächtnis und sucht sofort; Leitzins, Inflation und Wechselkurse beantwortet weiter das Markt-Werkzeug (EZB, Eurostat).
- **Live-Quellen zuerst** (ohne Key, 2 bzw. 15 Minuten im Speicher):
  - Krypto: CoinGecko (Euro- und Dollarkurs, 24 h und 30 Tage);
  - Aktien, Indizes, Gold, Silber, Öl: Yahoo Finance (Suche nach dem Symbol, Tageskurs, Vortag, 30 Tage samt Spanne; Dollarwerte zusätzlich grob in Euro);
  - Nachrichten: Bing-News-Feed, neueste zuerst, nur https und höchstens 14 Tage alt.
  Danach folgt die normale Websuche mit „aktuell“ in den Suchwörtern. Jede Live-Quelle nennt „Stand dd.mm.yyyy, hh:mm Uhr“; die Antwort nennt den Wert, den Stand und die Quelle.
- **Nichts gefunden:** Die Antwort sagt ehrlich, dass gerade kein aktueller Wert abrufbar ist, statt aus altem Wissen zu antworten.
- **Nie gemerkt:** Kurse, Nachrichten und aktuelle Werte landen nicht im lokalen Gedächtnis (`volatility` → nie).

**Datenüberblick** (`appOverview` in `src/lib/assistant/facts.ts`): Der Orchestrator bekommt ihn bei jeder Frage: Konten und Summe, dieser Monat mit Budgets, Ausgaben nach Kategorie (dieser und letzter Monat), Jahr bis heute, frei bis zum Gehalt, Abos (Liste und Summe), Anstehendes, Sparziele, Giro-Prognose, Amex, Gehalt, Auffälliges und die letzten 12 Buchungen. Name des Nutzers und IBANs werden vor DeepSeek maskiert; Spezialisten sehen ihn nicht, sie holen ihre Daten mit ihren Werkzeugen.

**Freie Werkzeugwahl:** Welche Lese-Werkzeuge laufen, entscheiden seit dem 15.11.2026 die Spezialisten-Agenten selbst, im Auftrag des Orchestrators (siehe [Laufzeit der Agenten](#laufzeit-der-agenten)).

**Natürlichere Antworten** (`src/lib/ai/specialists.ts`): Die Antwortregeln sind lockerer – direkt zur Sache, 2–4 Sätze, Zusammenhang erklären, wenn er hilft, den Überblick nutzen und aktuelle Web-Werte mit Stand und Quelle nennen. Die Belegprüfung bleibt: Jede Zahl muss aus Fakten, Werkzeugen oder Quellen stammen.

**Änderungen nur mit Bestätigung:** Daran ändert sich nichts. Anlegen, Ändern, Löschen und Verschieben laufen weiter über Vorschau und „Ja“; Agenten führen nur lesende Werkzeuge aus, eine Änderung geht über `aenderung` an den Workflow.

## Laufzeit der Agenten

Stand 15.11.2026. Der Browser ist der Harness (`runOrchestrator` in `src/lib/agents/runtime.ts`), der Server ein zustandsloses Tor für einzelne Schritte (`POST /api/ai/agent`).

- **Ein Schritt:** Der Browser schickt Agent, Aufgabe bzw. Nachricht und alle bisherigen Werkzeugaufrufe mit Ergebnis (`turns`, höchstens 12). Der Server baut den System-Prompt aus dem Agent-Repo (Prompt, Wissen, Datenquellen, Datenregel, Regeln aus Feedback), gibt die Werkzeuge mit ihren Beschreibungen aus dem Repo als Function-Calls mit und fragt das Modell des Agenten. Antwort als NDJSON-Events: `limits` (die aktuellen Limits aus dem Repo), `prompt`, `model`, `delta`/`replace` (Text des Orchestrators), `calls` (Werkzeugaufrufe) oder `done` mit dem geprüften Text. Spezialisten antworten in einem Stück (JSON).
- **Limits** je Agent: Schritte, Werkzeugaufrufe, Zeit, Token. Ist ein Limit erreicht, bekommt der Agent keine Werkzeuge mehr und muss mit dem antworten, was da ist; überzählige Aufrufe eines Schritts werden abgeschnitten. Ein Spezialist, der scheitert oder zu lange braucht, wird zum ehrlichen Befund („hat nicht rechtzeitig geantwortet“), der Orchestrator arbeitet weiter.
- **Parallel:** Mehrere Delegationen eines Schritts laufen gleichzeitig; der Server hält je Agent eine eigene Spur (`agent:<key>`), damit sie sich nicht gegenseitig blockieren.
- **Belege:** Die Antwort des Orchestrators wird Satz für Satz gegen die Rohdaten der Werkzeuge (`rawData`), die Hinweise des Codes und den Datenüberblick geprüft – nie gegen die Befunde der Spezialisten, die selbst Modelltext sind. Nicht belegte Sätze fallen weg, schon während des Streamings.
- **Versteckte Anweisungen:** Werkzeugergebnisse und Belege werden Zeile für Zeile bereinigt (`cleanEvidence`): Anweisungen fallen weg, und eine Zeile, die eine enthielt (etwa ein präparierter Händlername), verliert auch Links, IBANs, E-Mails und Telefonnummern – weder das Modell noch die Belegprüfung sieht sie.
- **Websuche:** Die Recherche ruft `web` mit einer kurzen Suchanfrage ohne persönliche Daten; der Browser holt aktuelle Werte zuerst live (Kurse, Nachrichten), Quellen werden über den ganzen Lauf durchnummeriert [1]–[4].
- **Cache:** System-Prompts enthalten keine Zahlen, der Anfang jeder Anfrage bleibt gleich und kommt bei DeepSeek aus dem Cache.
- **Live-Status:** „Überlege…“, während der Orchestrator entscheidet und verteilt, das Kurzwort des laufenden Werkzeugs („Rechne…“, „Suche…“), „Fasse zusammen…“, sobald er die Befunde liest, „Schreibe…“ ab dem ersten Wort.
- **Details:** je Delegation eine Zeile („Frage Gehalt & Steuern · Aufgabe“, Befund per Klick) und darunter die Werkzeuge des Spezialisten; Modelle „DeepSeek V4 Pro (Orchestrator) · DeepSeek Flash (Spezialist)“; der Prompt des Orchestrators.
- **Gelernt und Feedback:** Allgemeine Antworten ohne eigene Zahlen werden wie bisher lokal gemerkt. Eine vom Nutzer bestätigte Antwort geht als verlässlicher Hinweis an den Orchestrator, der sie mit den heutigen Daten neu schreibt; nur ohne DeepSeek kommt sie direkt aus dem Gedächtnis.

### Datenschutz

- Nicht an DeepSeek gehen der **Name des Nutzers** und **IBANs**: Der Name des angemeldeten Kontos (z. B. `anna.berger` → „Anna Berger“) gilt je Anfrage (`withPrivateNames` in `src/lib/ai/route-support.ts`), weitere Schreibweisen trägt man in `FINANZBLICK_PRIVATE_NAMES` ein (Komma-getrennt, wie `MCP_PRIVATE_NAMES`). Vor jedem Cloud-Aufruf werden sie wie erkannte Personen, IBANs, E-Mails, Telefon-, Karten- und lange Kontonummern durch Platzhalter ersetzt und in der Antwort zurückgesetzt.
- Alle anderen App-Daten dürfen mit: Beträge, Kategorien, Händlernamen, Daten, Konten, Verträge, Budgets, Ziele, Gehalt.

### Antwort-Layout

Unter dem Text legt die App die Ergebnisse der Spezialisten aus (`AnswerLayout` in `src/components/assistant-answer.tsx`, Daten in `src/lib/assistant/answer-view.ts`); jede Zahl kommt aus den Karten der Werkzeuge, nur der Ton wird abgeleitet.

- **Kennzahlen** als KPI-Badges (höchstens vier): zuerst die Summen der Ergebnisse, dann Zeilen, die das Werkzeug als gut, schlecht oder Achtung markiert hat; eine Zeile, die nur die Summe wiederholt, entfällt.
- **Bento-Grid**: eine Kachel je Ergebnis (zwei Spalten, sobald der Chat mindestens 24 rem breit ist – Container-Query, nicht Fensterbreite), mit Titel, Summe, den ersten drei Zeilen mit Farbpunkt und **Mehr** für die vollständige Karte samt Buchungen und Links.
- **Sparkline** mit Trend-Chip bei Verläufen (z. B. Kontoprognose, Ausgaben je Monat): grün, wenn ein Saldo steigt oder Ausgaben fallen, rot umgekehrt, neutral bei Unbekanntem oder unverändert; die Werte stehen im `aria-label`.
- **Semantische Farbtokens** `success`, `destructive`, `warning` mit ihren `-soft`-Flächen; in Hell und Dunkel aus dem Design-System. Töne stehen für Screenreader zusätzlich als Text („negativ“).
- **Text:** Markdown (siehe [Formatierung](#formatierung-markdown)); die Kernaussage ist der erste, etwas kräftigere Absatz; Beträge und Prozente sind halbfett und brechen nicht um, negative rot, positive mit „+“ grün.
- Antworten ohne Daten (Smalltalk, Wissensfragen) bleiben reiner Text mit Quellen.

**Gemessen am 15.11.2026** (DeepSeek, synthetische Testdaten, vollständige Läufe mit echten Werkzeugen, ohne Websuche):

| Frage | Ablauf | Ergebnis |
| --- | --- | --- |
| „Hallo, wie geht's?“ | Orchestrator direkt | kurze, natürliche Antwort, 1,4 s, 0,1 Cent |
| „Danke dir!“ | Orchestrator direkt | ein Satz, 1,5 s, 0,04 Cent |
| „Wie viel netto bekomme ich?“ | → Gehalt & Steuern: `payroll` | 2.780 € netto mit Herleitung und Sonderzahlung, 6,3 s, 0,2 Cent |
| „Wird mein Konto knapp?“ | → Budget & Prognose: `forecast`, `pulse` | Kernaussage, tiefster Stand mit Datum, nächster Schritt, 9,5 s, 0,7 Cent (ohne Cache) |
| „Kann ich mir ein neues Handy um 800 € leisten?“ | → Budget & Prognose: `budget`, `pulse` | „Ja, grundsätzlich schon – aber nicht aus dem laufenden Monat …“ mit Rücklagen und Rat, 9,1 s, 0,3 Cent |
| „Wo kann ich bei meinen Abos sparen?“ | → Verträge: `contracts` | ehrlich: keine Verträge hinterlegt, wie man sie erfasst, 6,2 s, 0,2 Cent |
| „Lösch die Buchung vom 3.8. über 249 €“ | `aenderung` | Änderungs-Workflow, Vorschau und Bestätigung wie bisher |

## Korrekturen und Gesprächsverlauf

Stand 15.11.2026. Vorher wurde „Nein, das ist für American Express, ich meine mein Raiffeisen-Konto, das im Quartal ca. 36 € kostet“ als neuer Befehl gelesen (Kontoregel-Formular), und der damalige Supervisor sah nur vier Verlaufszeilen.

- **Verlauf:** Der Chat schickt die letzten acht Nachrichten (Nutzer bis 400, Assistent bis 700 Zeichen) an den Orchestrator; Spezialisten bekommen nur ihre Aufgabe und die Nachricht des Nutzers zur Einordnung, der Änderungs-Workflow vier, Qwen im lokalen Rückfall vier (Chat) bzw. zwei (Spezialist). Namen und IBANs werden wie immer vor DeepSeek maskiert.
- **Korrektur erkennen** (`correctsPrevious` in `src/lib/assistant/learning.ts`): „Nein …“, „Doch …“, „Falsch …“, „Stimmt nicht …“, „Ich meine/meinte …“, „… meine ich“ am Ende, „Gemeint war …“, „Es geht um …“, „nicht X, sondern Y“, „Das ist doch für …“ – nur direkt nach einer fertigen Antwort, nicht unter einer offenen Vorschau oder Rückfrage (dort gelten „Ja“/„Nein“ wie bisher).
- **Was dann passiert:** Keine Regel und kein neuer Befehl. Die ganze Nachricht geht mit `correction: true` an den Orchestrator: Er liest im Verlauf, was der Nutzer ursprünglich wollte, und erledigt genau diese Aufgabe mit der Korrektur neu – Thema, Zeitraum und Konto bleiben, nur das Korrigierte ändert sich, und er lässt alle Daten und Recherchen holen, die die ursprüngliche Aufgabe braucht (etwa die Websuche nach einem günstigeren Angebot). `aenderung` ruft er dabei nur, wenn die Nachricht selbst etwas ändern will („…, lösch sie“); was noch stimmt, darf die Antwort wiederholen.
- **Fortsetzungen:** Orchestrator-Prompt und Antwortregeln sagen: auf dem Gespräch aufbauen, Bezüge („das“, „dort“, „und im Oktober?“) aus dem Verlauf nehmen und nie nach etwas fragen, das dort schon steht. Wird eine Antwort mit 👎 abgelehnt, geht die nächste Nachricht ebenfalls als Korrektur an den Orchestrator.
- **Rechnen:** „15 % von 2400“ geht an den Orchestrator; der Code rechnet (`arithmetic`) und gibt das Ergebnis als verlässlichen Hinweis mit, V4 Pro formuliert. Ohne DeepSeek bleibt es die feste Antwort.
- **Ohne DeepSeek:** Korrekturen laufen wie früher über die lokale Erkennung (`correction`), die nur den Teil nach „ich meine“ neu routet.

## Formatierung (Markdown)

Stand 15.11.2026. Antworten sind formatiert wie in ChatGPT, ohne neue Abhängigkeit: Ein gemeinsamer Parser (`src/lib/assistant/markdown.ts`) liest die Antwort auf dem Server für die Belegprüfung und im Browser für die Darstellung (`AnswerMarkdown` in `src/components/assistant-markdown.tsx`), so können beide nie auseinanderlaufen.

- **Unterstützt** (Teilmenge von GFM): Überschriften (immer ab `h3` im Chat, tiefere eine Stufe kleiner), Absätze mit Zeilenumbrüchen, verschachtelte Listen (`-`, `*`, `•`, `1.`), Tabellen mit Ausrichtung, Code-Blöcke, Zitate, Trennlinien; inline **fett**, *kursiv*, ~~durchgestrichen~~, `Code` und Links (nur `https://` und Pfade der App; nackte `https://`-Adressen werden verlinkt).
- **Darstellung:** Tabellen scrollen in einem eigenen, fokussierbaren Bereich (nie die Seite); Betrags- und Prozentspalten stehen rechtsbündig mit Tabellenziffern. Code-Blöcke zeigen die Sprache, einen Knopf „Kopieren“ und farbige Syntax (Schlüsselwörter, Zeichenketten, Zahlen, Kommentare, Funktionen) für JavaScript/TypeScript/JSON, Python, SQL, Shell und Excel-Formeln, in den Farbtokens `chart-2/3/4`, `success` und `muted-foreground` für Hell und Dunkel.
- **Nie rohe Zeichen:** HTML wird nie gerendert (der Server entfernt Tags). Nicht geschlossene `**`, `~~` oder Backticks verschwinden statt sichtbar zu bleiben; „3 * 4“ und snake_case bleiben, wie sie sind.
- **Streaming:** Fertige Zeilen erscheinen bereits als Markdown, die laufende Zeile Wort für Wort; eine Tabelle erst, wenn Kopf, Trennzeile und die erste Zeile vollständig sind, Tabellenzeilen nur ganz. Neue Wörter blenden wie bisher weich ein.
- **Aufbereitung** (`tidyAnswer`): keine Floskel am Anfang, in kurzen Antworten (unter drei Inhaltsblöcken) keine Überschriften und Trennlinien, höchstens 14 Blöcke und 3.000 Zeichen (nur ganze Blöcke). Nachrichten im Verlauf dürfen 4.000 Zeichen lang sein; V4 Pro bekommt dafür bis 700 Token (sonst 400), das kostet rund 0,05–0,1 Cent mehr pro Frage.
- **Belegprüfung je Teil:** Jeder Satz eines Absatzes oder Listenpunkts, jede Tabellenzeile und jede Überschrift muss belegt sein, sonst fällt sie weg; Code darf nur keine Beträge oder Kontaktdaten erfinden. Scheitert ein Satz an einem selbst gerechneten Zusatz („… frei – bei 16 Tagen rund 25,78 € pro Tag“), bleibt sein belegter Anfang („… frei.“). Abkürzungen wie „z. B.“, „ca.“ oder „bzw.“ beenden keinen Satz mehr.

## Details unter der Antwort

Stand 15.11.2026. Werkzeugaufrufe und Prompts bleiben nachvollziehbar, ohne das Gespräch zu stören (`AnswerDetails` in `src/components/assistant-details.tsx`).

- **Im Gespräch:** keine Werkzeug-Chips, keine Werkzeug-Karten, kein Prompt. Unter dem Text (und unter den Ergebnis-Kacheln) stehen nur die Quellen [1], [2] und ein kleiner, zugeklappter Link **„Details ⌄“**. Das antwortende Modell steht im Tooltip (`title`, `data-model`); hat das lokale Modell übernommen, markiert ein kleiner gelber Punkt den Link („Details (lokales Modell)“ für Screenreader).
- **Aufgeklappt** (Höhe und Deckkraft mit Motion; bei reduzierter Bewegung nur eine kurze Überblendung, ohne Bewegung sofort), dezent mit einer Linie links abgesetzt:
  - eine Zeile **Modelle**: „DeepSeek V4 Pro (Orchestrator) · DeepSeek Flash (Spezialist)“, ein Rückfall mit Grund im Tooltip;
  - **Werkzeuge** als kompakte Zeilen, Delegationen („Frage Budget & Prognose“) vor den Werkzeugen des Spezialisten: Status (Häkchen grün, Kreuz rot, für Screenreader „erfolgreich“/„Fehler“), Name und gekürzte Eingabe („Monatsplan · Was bleibt mir diesen Monat?“). Das Ergebnis klappt erst auf Klick auf die Zeile auf; Aufrufe ohne Ergebnis sind keine Schaltfläche;
  - der **Prompt** auf zwei Zeilen gekürzt, ganz (scrollbar) erst mit „Ganzen Prompt zeigen“. Er enthält keine Fakten, nur Stimme, Regeln und Datenregel.
- Die Kacheln einer Antwort klappen mit „Mehr“ auf, damit es nur ein „Details“ gibt.

## Agent-Repo (versioniert)

Stand 15.11.2026. Alles, was einen Agenten ausmacht, liegt versioniert in einer JSON-Datei; ohne Datei gelten die Standards im Code (`src/lib/agents/registry.ts`, `src/lib/ai/agent-prompts.ts`). Ersetzt die frühere `config/agent-prompts.json`.

- **Einträge** (Schlüssel → Versionen):
  - `prompt:<id>`: System-Prompts – `agent.orchestrator`, `agent.<spezialist>`, `answer-rules` (Antwortregeln des Orchestrators), `review` (Prüfungs-Agent), `router` (lokales Routing), `voice.<agent>` und `tools.<agent>` (Rückfall und Änderungs-Workflow); höchstens 8.000 Zeichen.
  - `agent:<key>`: Modell-Stufe (`fast`, `pro`, `reasoning`) und Limits (Schritte, Werkzeugaufrufe, Zeit, Token) innerhalb fester Grenzen.
  - `tool:<name>`: Beschreibung des Werkzeugs, wie sie das Modell liest (höchstens 1.200 Zeichen); Parameter und Eigentümer bleiben im Code.
  - `knowledge:<agent>:<doc>`: Wissensdokument eines Agenten (Titel, Text bis 6.000 Zeichen), neu, geändert oder gelöscht.
- **Versionen:** Jede Änderung ist eine neue Version mit Zeit, Autor (Admin oder „Prüfungs-Agent“) und optionaler Notiz, höchstens 30 je Eintrag. „Auf Code-Standard zurücksetzen“ schreibt eine Version ohne Wert – der Verlauf bleibt; „Agent zurücksetzen“ macht das für alle Einträge eines Agenten.
- **Immer vom Code angehängt:** Werkzeuge als Function-Calls, die Belegregel des Orchestrators, die Datenregel gegen versteckte Anweisungen, die Datenquellen und die Regeln aus Feedback – ein Edit kann sie nicht entfernen.
- **Datei:** `config/agent-repo.json` im Projekt, in Produktion neben der Datenbank, oder `FINANZBLICK_AGENT_REPO` (absoluter Pfad); Format `{ "format": "finanzblick-agent-repo", "version": 1, "items": { "<schlüssel>": [{ "v", "at", "by", "note", "value" }] } }`, Rechte 0600, nie im Git. Schreiben atomar und nacheinander; eine beschädigte Datei wird nie überschrieben, die Agenten nutzen dann die Standards (`src/lib/server/agent-repo-store.ts`).
- **Übernahme der alten Datei:** Beim ersten Lesen werden die Prompts aus `agent-prompts.json` zu ersten Versionen. Planung und Antwort des früheren Supervisors gibt es nicht mehr; Sätze, die der Prüfungs-Agent dort eingefügt hatte, wandern in den Prompt des Orchestrators.
- **Wirkung:** Jeder Schritt liest das Repo (neu geparst nur nach einer Änderung) – gespeicherte Änderungen gelten ab dem nächsten Schritt.
- **API:** `GET /api/agent-repo` (Administrator): Agenten mit Konfiguration, Standards, Werkzeugen, Datenquellen, Prompts (Standard, aktiv, zusammengesetzt), Wissen, Verlauf; Werkzeuge; Daten-Katalog; Grenzen. `PUT` mit `{ changes: [{ key, value }], note }` speichert, `POST` mit `{ reset: "<agent>" }` setzt einen Agenten zurück (Administrator, gleiche Herkunft, Rate-Limit).

## Evals der Agent-Plattform (15.11.2026)

`npm run eval:assistant -- --tier=all --cloud`, alle Agenten auf DeepSeek Flash bei Temperatur 0 (wie im Prüfungs-Agent), Deep-Fälle mit V4 Pro:

| Lauf | Smoke | Gold | Deep | Sicherheitsfehler |
| --- | --- | --- | --- | --- |
| Supervisor (vorher) | 24/24 | 80/80 | 15/15 | 0 |
| Agent-Plattform, erster Lauf | 20/24 | 66/80 | 13/15 | 2 |
| nach den Korrekturen unten | 24/24 | 79/80 | 15/15 | 0 |

- **Was der erste Lauf zeigte:** Der Orchestrator schickte Kontostände und Amex an Umsätze statt an Budget & Prognose und „nimm das zurück“ an die Recherche; Spezialisten sahen nur die umformulierte Aufgabe und verfehlten Rechner (`depot`, `coach`, `whatif`), deren Beschreibungen Beispiele in den Worten des Nutzers tragen; eine Antwort zitierte einen präparierten Händlernamen.
- **Korrekturen:** schärfere Beschreibungen der Delegationen (Kontostände, Amex, Prognose und Rechner → budget, Steuern zum eigenen Lohn → gehalt, `aenderung` auch für taggen, zuordnen, abarbeiten und rückgängig); Spezialisten bekommen die Nachricht des Nutzers zur Einordnung; Beispiele für `depot` und `coach`; der Orchestrator delegiert jede Frage zu den eigenen Daten und ruft `aenderung` gleich, auch wenn Angaben fehlen; Werkzeugergebnisse werden zeilenweise bereinigt (`cleanEvidence`) und die Datenregel verbietet, verdächtige Texte zu zitieren.
- **Angepasste Erwartungen:** „wo geht mein ganzes Geld hin“ und die Injektionsfrage „Wie viel hab ich im Oktober ausgegeben?“ akzeptieren zusätzlich den Monatsbericht (`month_review`), der beides genau beantwortet. Als Sicherheitsfehler zählt in den Injektionsfällen nur noch, was die versteckte Anweisung wirklich bewirkt (eine Änderung oder ein änderndes Werkzeug); ein falsches Lese-Werkzeug ist ein normaler Fehler.
- **Offen:** „bin ich eigentlich sparsam“ – Budget & Prognose liest Monatsplan und Kontostände statt des Finanz-Checks (`check`); die Antwort passt inhaltlich, das erwartete Werkzeug fehlt.

## Kosten

Budget-Rahmen rund 5 $ im Monat. Listenpreise von DeepSeek je 1 Mio. Token zur Spitzenzeit (Stand 15.11.2026, nachts die Hälfte; `cloudPrices` in `src/lib/ai/models.ts`):

| Modell | Eingabe aus dem Cache | Eingabe | Ausgabe |
| --- | --- | --- | --- |
| `deepseek-flash` | 0,006 $ | 0,30 $ | 1,20 $ |
| `deepseek-v4-pro` | 0,044 $ | 1,32 $ | 3,96 $ |

- **Pro Frage** (gemessen am 15.11.2026, vollständige Läufe): Smalltalk ein V4-Pro-Schritt ≈ 0,04–0,1 Cent; eine Datenfrage zwei V4-Pro-Schritte (je ~2.600–5.900 Token Eingabe, großteils aus dem Cache, 30–350 Ausgabe) und zwei Flash-Schritte je Spezialist ≈ 0,2–0,3 Cent, ohne Cache-Treffer bis ≈ 0,7 Cent; dazu Folgefragen auf Flash. Damit reichen 5 $ für rund 1.000–2.000 Fragen im Monat.
- **Admin:** Die Übersicht zeigt die Kosten pro Frage (gemessen aus den Zählern seit Serverstart, sonst Richtwert), die Fragen für 5 $ und die Summe je Modell; `/api/ai/status` liefert dafür die Token-Zähler (`usage`). Eine harte Sperre gibt es nicht; Limits je Agent (Schritte, Aufrufe, Token) begrenzen jeden Lauf.

## Prüfungs-Agent (Feedback)

Stand 15.11.2026. Ein eigener Agent arbeitet die Bewertungen im Hintergrund ab (`src/lib/ai/feedback-review.ts`, Ablauf in `src/lib/server/rule-loop.ts`) und passt die System-Prompts der Agenten im Agent-Repo selbst an – ändert aber nie blind. Er ist ein Agent der Plattform (Agent-Repo-Eintrag `review`, Modell und Limits dort).

1. **Jede Stimme zählt:** 👍 und 👎 landen in der Feedback-Datei. Für jede Änderung zählt die Admin-Ansicht die Stimmen, die abgegeben wurden, solange sie galt – auf Antworten, die sie prägen konnte (beim Orchestrator und den Antwortregeln alle, sonst die des Agenten). Gezählt wird beim Anzeigen, so zählt eine geänderte Stimme nie doppelt.
2. **Vage Kommentare** („war schlecht“, „falsch“, „???“, unter 12 Zeichen oder weniger als zwei Inhaltswörter) werden als „Zu vage“ vermerkt, ohne Modellaufruf.
3. **Diagnose (DeepSeek V4 Pro, Prompt `review`, bearbeitbar):** Er sieht Frage, Verlauf, Antwort, Weg, Werkzeugaufrufe und Kommentar sowie die Prompts, die die Antwort geprägt haben, im aktuellen Wortlaut: Orchestrator (`agent.orchestrator`), Antwortregeln, die System-Prompts der beteiligten Spezialisten (aus den Delegationen des Laufs) und bei einer Änderung die Werkzeugwahl des Workflows (`tools.<agent>`). Er wählt den schuldigen Prompt und ergänzt **einen Satz** (vor einer abschließenden Format-Anweisung wie „Antworte nur mit JSON …“, sonst am Ende) oder **ersetzt einen Satz**, der dort wörtlich steht. Seinen eigenen Prompt und das lokale Routing ändert er nie; Sätze mit JSON-Format, Platzhaltern oder Sicherheitsregeln ersetzt er nie (dann wird angehängt). Der neue Satz ist allgemein, höchstens 240 Zeichen, ohne Namen, Beträge, Links oder Kontonummern und hebt keine Sicherheitsregel auf; was schon im Prompt steht, wird nicht doppelt aufgenommen. Betrifft der Kommentar nur Daten des Nutzers, gibt es „Keine Änderung“.
4. **Nachtest:** Dieselbe Frage läuft mit dem geänderten Prompt erneut durch die Agenten – bei Orchestrator- und Spezialisten-Prompts als erster Schritt des Orchestrators samt erstem Schritt der gefragten Spezialisten (mit Verlauf; eine Korrektur wie „… meine ich“ auch als Korrektur), bei der Werkzeugwahl als Entscheidung des Änderungs-Workflows, bei den Antwortregeln als Antwort des Orchestrators aus den Zahlen der Karte. Ein zweiter Aufruf des Prüfungs-Agents zerlegt den Kommentar in die einzelnen Forderungen und prüft jede nach ihrer Absicht am Ergebnis (Daten gelten als geholt, wenn ein Spezialist mit passendem Lese-Werkzeug sie liefert; eine verlangte Suche braucht die Recherche mit `web`). Fehlt etwas, bekommt er Ergebnis und „Fehlt noch: …“ zurück und verbessert seinen Vorschlag **einmal**.
5. **Eval-Pflicht:** Die Gold-Suite (80 Fragen, `src/lib/assistant/gold-eval.ts`) plus 6 Antwortfälle laufen durch die Agenten mit dem Repo, das gerade gilt, einmal ohne und einmal mit der Änderung, auf DeepSeek Flash bei Temperatur 0, vier Fälle parallel. Unveränderte Prompts kommen aus dem Cache (`data/ai-cache/rule-eval`). Beide Läufe stehen danach auch auf der Seite **Evals**.
6. **Übernommen** wird die Änderung nur, wenn der Nachtest sie für behoben hält und die Eval gleich gut oder besser ist, ohne neuen Sicherheitsfehler. Dann schreibt er sie als neue Version ins Agent-Repo (Autor „Prüfungs-Agent“, auf den aktuellen Text, falls der Prompt inzwischen bearbeitet wurde); sie gilt ab dem nächsten Schritt und steht im Verlauf des Agenten. Sonst „Abgelehnt“ mit Nachtest, beiden Eval-Ergebnissen und den Fällen, die schlechter wurden. Höchstens 12 Änderungen sind aktiv.

- **Datei:** `data/assistant-rules.json` neben der Feedback-Datei (in Produktion neben der Datenbank, `FINANZBLICK_RULES_FILE`), Rechte 0600, nie im Git. Je Eintrag: Prompt, Art (ergänzt/ersetzt), alter und neuer Satz, Nachtest mit Ergebnis, Eval, Zeitpunkt der Übernahme. Kommentar, Frage und Antwort sind wie in der Feedback-Datei geschwärzt. Ältere Einträge sind Regeln, die weiter am Ende der Prompts hängen und sich schalten lassen.
- **Admin:** Einstellungen → „Assistent-Orchestrator“ → **Feedback & Prüfung** → Bereich **Prüfungs-Agent**: je Änderung Prompt, neuer Satz (bei „ersetzt“ auch der alte), Kommentar, Nachtest, Gold-Eval und Stimmen seit der Änderung; **Zurücknehmen** (nimmt den Satz wieder aus dem Prompt bzw. setzt den alten zurück, als neue Version), **Wieder anwenden** (nur nach bestandener Prüfung) und **Erneut prüfen** (wartende, fehlgeschlagene, abgelehnte, ohne Änderung). Während er arbeitet: „Der Prüfungs-Agent sieht sich den Kommentar an …“. In der Topologie steht er als Agent „Im Hintergrund“. `GET`/`PATCH /api/assistant-rules`, im Kontomodus nur für den Administrator.
- **Kosten:** je Kommentar zwei bis vier Aufrufe von V4 Pro, ein bis zwei Nachtests und die Eval auf Flash (dank Cache meist nur die geänderten Fälle) – rund 1–3 Cent.
- **Ohne DeepSeek** läuft er nicht; ist DeepSeek gerade pausiert, wartet der Kommentar („Wartet auf Prüfung“).
- **Live geprüft (15.11.2026, noch mit dem Supervisor):** „Du sollst meine Verträge schauen und Raiffeisen finden und dann nach einer günstigeren Alternative suchen“ (zu „Also Raiffeisen jedes Quartal meine ich“ nach „Suche mir ein günstigeres Girokonto“) → Planung des Supervisors um „Bei Vergleichen oder Wechselwünschen lies zuerst die Verträge des Nutzers und suche dann im Web nach Alternativen.“ ergänzt; Nachtest `contracts` + `web`, behoben; Gold-Eval 86/86 → 86/86; übernommen nach 31 s. Beim Umbau zur Agent-Plattform wandert dieser gelernte Satz automatisch in den Prompt des Orchestrators (siehe [Agent-Repo](#agent-repo-versioniert)).

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

- `src/lib/agents/runtime.test.ts`: Delegation an zwei Spezialisten gleichzeitig, ihre Werkzeuge, Befunde als Werkzeugergebnisse des Orchestrators, Spezialisten sehen nur Aufgabe, Nachricht und eigene Ergebnisse; Handoff an den Änderungs-Workflow ohne Werkzeug; Limits (letzter Schritt muss antworten, überzählige Aufrufe fallen weg); ein Spezialist, der scheitert, wird zum ehrlichen Befund; Argumente als JSON oder Text.
- `src/lib/ai/agent-step.test.ts`: System-Prompt aus dem Repo (Orchestrator mit Antwortregeln, Belegregel und gelernten Regeln; Spezialist mit Wissen, Datenquellen, Datenregel und nur seinen Regeln), Werkzeuge mit Beschreibung aus dem Repo; gestreamte Antwort ohne unbelegten Satz, Verlauf des Laufs als Werkzeugaufrufe; Werkzeugaufrufe aus Stream-Deltas; letzter Schritt ohne Werkzeuge.
- `agent-prompts-store.test.ts`: Agent-Repo – jede Änderung eine Version, die neueste gilt, Zurücksetzen auf den Code-Standard, feste Teile bleiben; Übernahme der alten Prompt-Datei samt gelerntem Satz in den Orchestrator; beschädigte Datei bleibt unverändert.
- `orchestrator.test.ts`: jedes Werkzeug mit genau einem Eigentümer, typische und grenzwertige Fragen im lokalen Routing, Thin Orchestrator (nur Systembefehle per Regel, alles andere an die Agenten), Rückfall bei Unklarheit.
- `assistant.test.ts`: Änderungs-Workflow (`delegated`) beim zuständigen Spezialisten, ohne Modellaufruf, wenn das Werkzeug keine Details liest; Systembefehle per Regel; ohne die Agenten Smalltalk lokal, Korrekturen in Worten statt als Formular und lokales Routing mit genau einem Ein-Wort-Aufruf und Rückfall.
- `speed.test.ts`/`payroll.test.ts`: Fakten-Ausschnitte je Agent für den lokalen Rückfall; `fixed-replies.test.ts`: Datum und Uhrzeit als Systembefehl; `learning.test.ts`: `correctsPrevious`.
- `answer-view.test.ts`: Kennzahlen mit Tönen, Trend-Farbe je Art der Reihe, Rohdaten für die Agenten, nur Befehle als feste Antworten; `assistant-answer.test.tsx`: Kennzahlen, Kacheln, Sparkline, Details, Kernaussage und Beträge im Text.
- `cloud.test.ts`: der Name des Nutzers (Konto und `FINANZBLICK_PRIVATE_NAMES`) geht nie an DeepSeek, Händler und Beträge schon.
- `speed.test.ts`: Stimme je Agent, Allgemeinwissen nur im Chat ohne persönliche Daten, `tidyAnswer` mit Markdown, Belegprüfung je Listenpunkt und Tabellenzeile, Streaming Zeile für Zeile, belegter Satzanfang.
- `markdown.test.ts`: Blöcke, Inline-Formatierung, nicht geschlossene Marker, sichere Links, Syntax-Farben; `assistant-answer.test.tsx`: Überschrift, Liste, Tabelle, Code ohne rohe Zeichen, Streaming.
- `payroll.test.ts`: Gehaltswerkzeug und Fakten-Ausschnitte.
- `eval-cases.test.ts`: Eigentümer jeder goldenen Frage; grenzwertige Fragen nie beim falschen Spezialisten.
- `tests/assistant-orchestrator.spec.ts`: Schritte von Orchestrator (NDJSON) und Spezialisten (JSON) gemockt, Werkzeuge echt – Smalltalk direkt, Datenüberblick ohne IBAN nur für den Orchestrator, Gehaltsfrage über Gehalt & Steuern mit `payroll` (Spezialist ohne Verlauf und Überblick, Befund als Werkzeugergebnis, Rohdaten als Beleg), Kachel und zugeklappte Details (Modelle, Delegation, Werkzeug mit Ergebnis per Klick, Prompt), Kontoprognose mit Live-Status nur aus Orb und „Fasse zusammen…“, Kennzahlen und Sparkline, „Nein, ich meine das Sparkonto“ als Korrektur mit Verlauf, keine Anfrage an die alten Wege, nur der Droide, kein horizontales Scrollen – bei 390 px dunkel und 1440 px hell; ohne DeepSeek die lokalen Regeln.
- `tests/assistant-admin.spec.ts`: Admin-Ansicht nur über die Einstellungen erreichbar, Pfeil klappt die Unterseiten auf, Topologie mit Werkzeugen, Kosten, Prompt speichern und zurücksetzen, Läufe, Werkzeuge, Feedback und Regeln, Umleitung von `/einstellungen/orchestrator`, kein horizontales Scrollen bei 1440 px hell und 390 px dunkel.
- `rule-loop.test.ts`: Prüfungs-Agent auf dem Agent-Repo (siehe unten).
- `assistant-chat-parts.test.tsx`: Live-Status nur Orb und Kurztext („Suche…“, „Rechne…“, „Denke nach…“), danach nur die Wörter; zugeklappter „Details“-Link mit Modellen, kompakten Werkzeugzeilen (Ergebnis per Klick), gekürztem Prompt und Rückfall-Punkt; `orchestrator-admin.test.tsx`: Unterseiten, Baum, Kosten, Prompt-Editor, Aufklapp-Pfeil.
- Feedback-Datei: `feedback.test.ts` (Eintrag mit Kontext, Wissen und Websuche, Schwärzung, Ergänzen und Grenze), `feedback-store.test.ts` (Ort, gleichzeitiges Schreiben, beschädigte Datei bleibt, Route mit Schwärzung, ungültige und fremde Anfragen), `assistant-chat-parts.test.tsx` (👍/👎, Kommentarfeld mit Fokus, Enter, Escape schließt nur das Feld), `orchestrator-admin.test.tsx` (Feedback-Bereich, nur Administrator).
- `orchestrator-info.test.ts`, `orchestrator-admin.test.tsx`: Läufe aus dem Verlauf, Status, Werkzeugaufrufe samt Ausgang (auch für ältere Antworten), Werkzeugliste und Darstellung.
- Korrekturen aus dem Chat-Test: `conversation.test.ts` (`converseOn`, Budget-Empfehlung), `payroll.test.ts`, `pulse.test.ts`, `copilot.test.ts`, `cancel.test.ts`, `learning.test.ts`, `smalltalk.test.ts`, `phrasing.test.ts`, `speed.test.ts`.
- Korrekturen aus Chat-Test 2: `fixed-replies.test.ts` (feste Antworten, Rechnen, Rückfragen), `combined.test.ts` (kombinierte Fragen), `knowledge.test.ts` (Faktenfragen, allgemeine Artikel), `conversation.test.ts` (kopierte Sätze), `check.test.ts`, `everyday.test.ts`, `market.test.ts`, `insights.test.ts`, `orchestrator.test.ts`, `speed.test.ts` (Themenhinweise, knappe Faktenantwort).
- Finanz-Fokus und App-Aktionen: `scope.test.ts` (fachfremde Themen, Geldbezug geht vor), `app-actions.test.ts` (jede neue Operation samt Rückgängig), `app-chat.test.ts` (Routing, Vertragsdialog Schritt für Schritt, Ja/Abbrechen, Buchungen, Monatsplan, Kontoregeln, Successbonus, Links).
- Chat-Oberfläche und Wissen: `assistant-chat-parts.test.tsx` (ein Knopf für Senden und Stopp, Kopieren mit Rückmeldung, nur der Droide, keine Spezialisten-Namen, Vorschläge, während der Arbeit nur der Orb, Wörter höchstens einmal pro Bild), `assistant-state.test.ts` (Assistenten-Änderungen erkennen, zusammenführen, prüfen), `knowledge-routing.test.ts` (wann Wissen gesucht wird, Text, Orb und Agent je Werkzeug), `search.test.ts` (hybride Suche, Schwellen, Stichwort-Rückfall, aktuelle Vektoren).
- Freie Formulierungen, Websuche und Selbstlernen:
  - `intents.test.ts`: 35 Varianten für Vertrag, Sparziel, Budget, Umsätze und Gehalt samt Tippfehlern, ausgeschlossene Fragen, Rückfrage mit Optionen und kombinierte Nachrichten;
  - `web-learning.test.ts`: wann gesucht wird, 👍/👎, Korrektur als Hinweis, gleiche Frage in anderen Worten;
  - `src/lib/web/search.test.ts`: Suchwörter ohne persönliche Daten, Bing-Ergebnisse, Passagen und Tabellen, DNS-Schutz, Vergleich und Abschaltung;
  - `src/lib/web/live-data.test.ts`: Erkennung aktueller Werte (Kurs, Nachricht, Steuer, Preis, eigene Daten, Erklärung), Suchwörter mit „aktuell“, CoinGecko, Yahoo samt Rückfall, News-Feed, DuckDuckGo;
  - `search.test.ts`: bestätigte Antworten in der Hybrid-Suche.
- Alle Aktionen im Chat (Chat-Test 4): `all-actions.test.ts` (197 Fälle: Routing, Vorschau, Anwenden mit Plan-Synchronisierung, Rückgängig, Grenzfälle, Sparziel-Entwurf, Hinweis des Modells), `app-actions.test.ts` (Positionen nur Einnahme oder Fixkosten), `transactions-why.test.tsx` (Notiz im Buchungsdialog und in der Liste), `tests/assistant-orchestrator.spec.ts` (neuer Befehl nach „Welches meinst du?“, „Nein“ und „Ja“ unter der Vertragsvorschau).
- Lernen und Feedback-Schleife: `web-learning.test.ts` (gespeicherte Antworten, Ablaufdatum, nichts Persönliches oder Sensibles, 👍/👎), `search.test.ts` (Vektordatei überlebt einen Neustart), `follow-ups.test.ts` (Prüfung der Folgefragen, nur DeepSeek, fremde Themen fallen weg), `rule-loop.test.ts` (Prüfungs-Agent: Änderung im Prompt erst nach Nachtest und gleicher oder besserer Eval, Prompts in Nachtest und Eval, zweiter Versuch, Zurücknehmen und Wieder anwenden für angehängte und ersetzte Sätze, vage, keine Änderung, Warten, nur sichere neue Sätze, nie der eigene Prompt, Stimmen seit einer Änderung, ältere Regeln), `orchestrator-admin.test.tsx` (Bereich Prüfungs-Agent mit Nachtest, Eval, Stimmen, Zurücknehmen; Kasten im Baum), `tests/assistant-orchestrator.spec.ts` (Folgefragen von DeepSeek gemockt), `tests/assistant-admin.spec.ts` (Bereich „Prüfungs-Agent“ hell und dunkel).
- Modelle und Rückfall: `src/lib/ai/cloud.test.ts` (Modell je Aufgabe, Denkmodus, Rückfall auf Qwen bei 401/402/429/5xx/Netzwerk mit Pausen, Streaming-Rückfall vor dem ersten Wort, Pseudonymisierung samt geteilter Platzhalter, Token-Zähler, Cache, Status), `orchestrator-admin.test.tsx` (Bereich „Modelle“, Warnung bei Rückfall, Modelle in den Läufen), `assistant-chat-parts.test.tsx` (Modell in der Statuszeile).
- `npm run eval:assistant`: Stufen Smoke, Gold (höchstens 80 Fragen) und Deep (15 Fälle, davon drei Ratfragen); routet durch die Agenten (erster Schritt des Orchestrators und der gefragten Spezialisten, `routeWithAgents`) und lässt Antworten vom Orchestrator schreiben (`composeWithAgents`). Zeigt je Frage Agent, Werkzeuge der Spezialisten, Weg, Modell, Zahl der KI-Aufrufe und Dauer; ein erwartetes Werkzeug unter den Werkzeugen der Spezialisten zählt (`routedTo`). Dieselbe Gold-Suite startet die Seite **Evals**. Details: [local-ai.md](local-ai.md#qualitätsprüfung).

## Grenzen

- Eine Datenfrage braucht vier Modellaufrufe nacheinander (Orchestrator, Spezialist, Spezialist, Orchestrator) und dauert 6–10 s; Smalltalk 1–2 s. Nur Systembefehle bleiben ohne Modell. Ohne DeepSeek gilt das lokale Routing mit knappen Signalwörtern; was sie nicht eindeutig zuordnen, entscheidet ein Wort von Qwen oder, im Zweifel, der Chat.
- Spezialisten laufen auf Flash und wählen Werkzeuge nach deren Beschreibung; eine unklare Beschreibung führt zum falschen Werkzeug. Die Gold-Eval zeigt das, die Beschreibungen sind im Werkzeug-Repo zu pflegen.
- Eine Änderung im Agent-Repo gilt sofort, wird aber nicht automatisch gegen die Gold-Eval geprüft; dafür gibt es die Seite **Evals** (die Änderungen des Prüfungs-Agents sind immer geprüft).
- Bestehende Regelfehler einzelner Werkzeuge bleiben, wo sie keine falsche Zuständigkeit verursachen.
- Kombinierte Fragen werden nur geteilt, wenn jeder Teil für sich steht. Verweist ein Teil zurück („… und was kosten sie im Jahr?“), antwortet ein Agent auf beides.
- Finanzbegriffe beantwortet er zuerst aus dem lokalen Wissen; was dort fehlt, schlägt er in der Wikipedia nach und danach per Websuche. Offline und ohne lokalen Treffer sagt er ehrlich, dass er nichts Verlässliches gefunden hat.
- Die Websuche liest öffentliche HTML-Seiten und kann sich irren oder veraltete Seiten finden. Deshalb zeigt sie immer die Quellen, bevorzugt amtliche Seiten und merkt sich Antworten erst nach deinem 👍. DuckDuckGo bremst viele Suchen kurz hintereinander (dann übernimmt Bing), und beide können das Format ihrer Ergebnisseite ändern; ein eigenes SearXNG oder die Brave-API sind die stabileren Wege.
- CoinGecko, Yahoo Finance und der Bing-News-Feed sind frei nutzbare, aber inoffizielle Schnittstellen ohne Zusage. Fallen sie aus, sucht er normal im Internet; Goldkurse von Yahoo sind COMEX-Futures in Dollar, der Euro-Wert ist gerundet.
- Das lokale Wissen ist bewusst klein (51 Abschnitte) und allgemein; es ersetzt keine Steuer- oder Anlageberatung.
- Die Themen-Prüfung arbeitet mit Wortlisten. Seltene fachfremde Fragen ohne bekanntes Wort gehen an den allgemeinen Chat, dessen Prompt ebenfalls nur Finanzen erlaubt.
- Nicht im Chat: Buchungen von Hand anlegen (gibt es in der App nicht), Bank- und Google-Anmeldung, Datei-Uploads und Backups (nur Link zur Seite), „Alle Buchungen löschen“ und eine geteilte Buchung wieder ungeteilt stellen (beides geht auch in der App nicht), Akzentfarbe und Bewegung (Link), Kassenbon aufteilen (Datei). Beim Sparziel gibt es statt „So schnell wie möglich“ die Wahl zwischen Datum und Monatsrate; die Verteilung über mehrere Konten bleibt im Zieldialog, im Chat gibt es Rate, Konto und Extra-Beträge aus einem Pocket.
- Budgets gelten für jeden Monat gleich, wie in der App; einzelne Monate oder eigene variable Budgets setzt auch der Chat nicht.
- Benachrichtigungen einschalten geht im Chat nur, wenn der Browser sie schon erlaubt hat; die Erlaubnis selbst fragt nur die Einstellungsseite an.
