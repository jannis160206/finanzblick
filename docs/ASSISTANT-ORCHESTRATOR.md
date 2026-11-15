# Finanz-Assistent: Orchestrator, Supervisor und Spezialisten

Stand: 15.11.2026

## Ausgangslage (vorher)

- **Ein Router für alles:** `/api/ai/assistant` schickte jede unklare Nachricht mit einem großen Prompt (48 Werkzeuge, rund 60 Beispiele, alle Kategorien, sechs Verlaufszeilen) an das Modell. Bei einem Fehler des Router-Modells folgte ein zweiter Aufruf mit dem Hauptmodell.
- **Eine Stimme für alles:** Freie Antworten bekamen immer alle Fakten (mit echten Daten rund 6.300 Zeichen), auch für Smalltalk oder Wissensfragen.
- **Bis zu drei KI-Aufrufe pro Nachricht:** Router-Modell, Hauptmodell, freie Antwort.
- **Gemessen mit Qwen3-8B auf der NPU** (`npm run eval:assistant`):
  - 97 von 98 goldenen Fragen richtig;
  - Modellaufrufe des Routers dauerten 5–11 s (Median 8,3 s, Ausreißer 23 s).

## Architektur

Thin Orchestrator mit Supervisor-Worker-Muster, ohne Framework, im bestehenden TypeScript-Code:

- **Thin Orchestrator** (`orchestrate` in `src/lib/assistant/orchestrator.ts`): macht keine Facharbeit, sondern entscheidet nur, wer übernimmt. Feste Regeln gibt es nur noch für Systembefehle (Datum, Uhrzeit, Navigation, Einstellungen) und laufende Formulare; jede andere Nachricht – auch Änderungen, Rechnen und Korrekturen – bekommt der Supervisor samt Gesprächsverlauf, ein erkanntes Werkzeug nur als Hinweis.
- **Supervisor** (`src/lib/ai/supervisor.ts`): DeepSeek Flash bekommt einen Überblick über alle App-Daten, entscheidet bei jeder Anfrage selbst, welche Daten oder Recherchen nötig sind, und lässt die Spezialisten sie holen; DeepSeek V4 Pro schreibt danach jede Analyse-, Erklärungs- und Beratungsantwort.
- **Spezialisten (Worker):** führen ihre Werkzeuge aus (der Code rechnet im Browser auf den eigenen Daten) und geben Rohdaten zurück; formuliert wird nur vom Supervisor. Änderungen füllt der zuständige Spezialist aus; sie laufen wie bisher nur über Vorschau und Bestätigung.
- **Chat-UI:** nur der Droide; welcher Spezialist gearbeitet hat, bleibt intern (Admin-Ansicht).

Siehe [Supervisor](#supervisor-deepseek-flash-plant-v4-pro-schreibt).

| Agent | Zuständig für | Werkzeuge (je genau ein Eigentümer) |
|---|---|---|
| **Umsätze** | vergangene Buchungen, Ausgaben und Einnahmen, Händler, Kategorien, Monats- und Jahresrückblick, Doppel- und verdächtige Buchungen, Rückerstattungen, offene Bestellungen, geteilte Kosten; Buchungen bearbeiten, löschen, taggen und teilen | `query`, `booking`, `rule`, `cleanup`, `why`, `security`, `refunds`, `context`, `orders`, `shared`, `month_review`, `review` |
| **Verträge** | Abos und Verträge, Kosten, Laufzeit, Fristen, Kündigen; Verträge Schritt für Schritt anlegen, ändern, bestätigen, ausblenden, als gekündigt markieren | `contracts`, `cancel`, `contract_new`, `contract_edit` |
| **Budget & Prognose** | Monatsplan, Kontostände, Prognose, Sparziele, geplante Ausgaben, „Geht sich das aus?“, Spartipps, Anlegen, Kredite; Budgets, Monatsplan-Positionen, Monatswerte und Kontoregeln ändern | `budget`, `budget_plan`, `pulse`, `forecast`, `funds`, `account_rule`, Entwürfe (`savings_goal`, `expense`, `affordability`), `edit`, `batch`, `whatif`, `coach`, `check`, `briefing`, `insights`, `accounts`, `amex`, `networth`, `depot`, `loan` |
| **Gehalt & Steuern** | Lohnabrechnung, netto und brutto, Sonderzahlungen samt Anteil zu 6 % und voll versteuert, Jahressechstel, Arbeitnehmerveranlagung | `payroll` (auch Successbonus), `tax`, `homeoffice` |
| **Allgemeiner Chat** (kein Spezialist, Rückfallebene) | Begrüßung, allgemeine Geldfragen, Finanzbegriffe, Bedienung, Marktdaten, Gedächtnis; alles Unklare. Fachfremde Themen lehnt er ab | `help`, `explain`, `knowledge`, `market`, `memory`, `remember`, `forget`, `changes`, `undo`, `reminder`, `ask` |

**Annahme:** Die Vorgabe „strikt maximal 4 Spezialisten“ nennt fünf Bereiche. Der allgemeine Chat ist deshalb kein Spezialist, sondern die Rückfallebene des Orchestrators. So bleibt es bei vier Spezialisten.

**Dateien**

- `src/lib/assistant/orchestrator.ts`: Agenten, Werkzeug-Eigentümer, Thin Orchestrator (`orchestrate`), lokales Routing (Signalwörter, `routeByRules`, `parseAgent`).
- `src/lib/ai/supervisor.ts`: Supervisor-Prompt (alle Spezialisten mit ihren Werkzeugen), Prüfung des Plans (`cleanSupervision`).
- `src/lib/ai/specialists.ts`: Ein-Wort-Prompt für das lokale Routing, Werkzeug-Prompt je Spezialist, Stimme je Agent und Zusatz für die Supervisor-Antwort.
- `src/lib/ai/assistant.ts`: Ablauf auf dem Server.
- `src/lib/assistant/specialist-context.ts`: Fakten-Ausschnitt und Kontext-Werkzeug je Agent.
- `src/lib/assistant/payroll.ts`: neues Werkzeug für Gehalt & Steuern.
- `src/lib/assistant/fixed-replies.ts`: Systembefehle (`fixedCommand`: Datum und Uhrzeit, Farbschema, Geräte-Einstellungen, Navigation, Links für Aktionen, die nur auf ihrer Seite gehen), Rechnen (`arithmetic`: das Ergebnis des Codes als Evidenz für V4 Pro); die übrigen festen Antworten und Rückfragen auf einzelne Wörter nur noch ohne DeepSeek.
- `src/lib/assistant/answer-view.ts`, `src/components/assistant-answer.tsx`: Antwort-Layout (Kennzahlen, Kacheln, Trends, Töne).
- `src/lib/ai/private-names.ts`: Name des angemeldeten Nutzers je Anfrage, für die Maskierung vor DeepSeek.
- `src/lib/assistant/scope.ts`: erkennt fachfremde Themen und antwortet mit einem freundlichen Nein.
- `src/lib/assistant/contract-draft.ts`, `contract-actions.ts`, `contract-requests.ts`, `booking-actions.ts`, `plan-rows.ts`: App-Aktionen im Chat (siehe unten).
- `src/lib/assistant/combined.ts`: teilt kombinierte Fragen in Teilfragen mit je eigenem Werkzeug.

## Ablauf und KI-Aufrufe

1. **Systembefehle (0 Aufrufe, Thin Orchestrator):** nur sie laufen ohne Supervisor:
   - feste Befehle im Chat (`fixedCommand`): Datum und Uhrzeit („Welcher Tag ist heute?“, „Wie spät ist es?“ – nicht „… in Tokio“), Farbschema, Geräte-Einstellungen, „Öffne die Verträge“ und Aktionen, die nur auf ihrer Seite gehen („Lösche alle Buchungen“ mit Link);
   - laufende Formulare: offene Entwürfe, „Ja“/„Nein“ unter einer Vorschau, Rückgängig, Feedback und gelernte eigene Wörter („Mit Japan meine ich Motorrad“).
2. **Supervisor (1 Aufruf, DeepSeek Flash; Korrekturen V4 Pro):** jede andere Nachricht – Fragen, Änderungen, Rechnen, Korrekturen, Rat, Smalltalk, Begriffe, Recherche, aktuelle Werte. Er bekommt die letzten acht Nachrichten und den Datenüberblick und entscheidet selbst, was die Antwort braucht:
   - `antwort`: 0–4 Lese-Schritte mit je einer Teilfrage – Werkzeuge der Spezialisten auf den eigenen Daten, `knowledge` (lokales Finanzwissen) oder `web`; reicht der Überblick, keiner;
   - `aktion`: Der zuständige Spezialist übernimmt das Werkzeug, das die Regeln erkennen, und liest Details mit seinem Werkzeug-Prompt (V4 Pro) aus, etwa „Lösche die Buchung MediaMarkt vom 24.10.“ oder „Setze Tanken im Dezember auf 150 €“; Vorschau und Bestätigung wie bisher;
   - `rueckfrage`: nur, wenn eine Angabe fehlt, die weder in den Daten noch im Internet steht.
3. **Spezialisten (Worker):** Die Schritte laufen im Browser auf den eigenen Daten (`runWorkers`). Jedes Werkzeug liefert Rohdaten (`rawData`: Zahlen Zeile für Zeile mit Ton, Verlauf, Befund) und seine Karte; einen eigenen Antworttext zeigen sie nicht mehr. Begriffe und Recherche gehen immer auch an die Websuche, aktuelle Werte zuerst live.
4. **Antwort (1 Aufruf, gestreamt, DeepSeek V4 Pro):** Der Supervisor schreibt aus Rohdaten, den Fakten aller beteiligten Spezialisten (`contextFacts`), Datenüberblick, lokalem Wissen und Webquellen die Antwort – bei jeder Analyse, Zusammenfassung, Bewertung, Recherche und Erklärung; nur Begrüßung, Dank und kreative Bitten ohne Daten schreibt Flash (`briefTalk`); darunter legt die App die Ergebnisse als Kennzahlen und Kacheln aus (siehe [Antwort-Layout](#antwort-layout)). Gibt die Antwort zu, etwas nicht zu wissen, sucht er einmal im Web und schreibt neu.
5. **Lokaler Rückfall ohne DeepSeek:** Fällt der Supervisor aus (kein Key, Pause, Fehler, unlesbarer Plan), meldet der Server `local`, und der Chat nutzt zwei Minuten lang die früheren festen Wege: Smalltalk, feste Antworten, Themen-Rückfragen, kombinierte Fragen, Folgefragen, gelernte Formulierungen, Regeln, Signalwörter genau eines Spezialisten, sonst ein Wort vom Modell (`umsaetze`, `vertraege`, `budget`, `gehalt`, `chat`). Qwen antwortet, Werkzeuge zeigen ihren eigenen Text.

**Damit:** Jede Frage kostet einen Flash-Aufruf für den Plan (1,2–1,8 s, der Prompt kommt meist aus dem Cache) und eine Antwort von V4 Pro; nur Systembefehle und laufende Formulare kommen ohne Modell aus. Eine Änderung kostet zusätzlich den Plan (rund 1 s mehr als früher); einen Aufruf für den Spezialisten (V4 Pro) nur, wenn er Details lesen muss (Buchungen, Monatswerte, Regeln, Entwürfe) oder die Regeln das Werkzeug nicht kennen. Kosten: siehe [Kosten](#kosten).

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
  - Sie sehen die letzten vier Nachrichten, der Supervisor und seine Antwort die letzten acht (siehe [Korrekturen und Gesprächsverlauf](#korrekturen-und-gesprächsverlauf)).
- **Wann das Modell den Werkzeugtext umformuliert (`converseOn`):**
  - Nicht bei leeren Ergebnissen: „keine Daten“ bleibt der ehrliche Werkzeugsatz statt eines erfundenen Absatzes.
  - Nicht bei Werkzeugen, deren Text schon die Antwort ist (Überblicke, Rückblicke, Hinweise, „Warum …?“-Erklärungen, Was-wäre-wenn, Gehalt), außer bei Rat- und Meinungsfragen oder wenn nur das Modell das Werkzeug geraten hat.
  - Floskeln am Anfang („Kurz gesagt:“, „Du willst wissen …?“) und doppelte Sätze werden entfernt.
- **Kennzeichnung:** Unter jeder Antwort steht nur ein kleiner, zugeklappter Link „Details“ (das Modell als Tooltip, beim Rückfall auf Qwen ein kleiner gelber Punkt); siehe [Details unter der Antwort](#details-unter-der-antwort). Der zuständige Bereich bleibt intern: Er steht als optionales Feld `agent` im Chatverlauf und in der Admin-Ansicht, nicht im Chat.

## Modelle je Aufgabe

Ist ein DeepSeek-Key hinterlegt, wählt `src/lib/ai/client.ts` das Modell nach der Aufgabe des Aufrufs; ohne Key oder bei jedem Ausfall antwortet das lokale Qwen3-8B. Einrichtung, Rückfallregeln und Datenschutz: [local-ai.md](local-ai.md#deepseek-je-aufgabe-qwen-als-rückfall).

| Schritt | Aufgabe | Modell |
| --- | --- | --- |
| Aufgabe zerlegen: Spezialisten, Lese-Werkzeuge, Aktion oder Rückfrage | Supervisor | DeepSeek Flash (nur DeepSeek, sonst lokales Routing) |
| Antwort aus den Ergebnissen der Spezialisten: Analyse, Zusammenfassung, Bewertung, Recherche, Erklärung | Supervisor-Antwort | DeepSeek V4 Pro ohne Denkmodus (Steuer-Analysen an Gehalt & Steuern im Denkmodus); Smalltalk und kreative Bitten ohne Daten: DeepSeek Flash |
| Werkzeug-Hinweise und Entwürfe lesen, lokales Routing | Werkzeugwahl | DeepSeek Flash |
| Korrektur der vorigen Antwort („Nein, ich meine …“): Plan mit Verlauf | Supervisor | DeepSeek V4 Pro (ohne Denkmodus) |
| Offener Entwurf, ändernde Regel-Werkzeuge, mehrere Befehle, „anlegen/ändern/lösche…“ | Aktion | DeepSeek V4 Pro (ohne Denkmodus) |
| Freie Antwort | Antwort | DeepSeek Flash |
| „Warum…“, „Lohnt sich…“, „Sollte ich…“, Vergleiche, Steuerfragen | Analyse | DeepSeek V4 Pro im Denkmodus |
| Antwort aus der Websuche | Websuche | DeepSeek Flash |
| 2–3 Folgefragen unter jeder Antwort | Folgefragen | DeepSeek Flash (nur DeepSeek, sonst feste Vorschläge) |
| Regel aus einem 👎-Kommentar | Regel aus Feedback | DeepSeek V4 Pro (nur DeepSeek) |

Mit DeepSeek entfällt das kleine lokale Router-Modell. Die Entscheidung liegt in `interpretTask` (`src/lib/ai/assistant.ts`) und `answerTask` (`src/lib/ai/answer.ts`); beide rechnen ohne Modell.

## Admin-Ansicht

Eine versteckte Seite unter **Einstellungen → „Assistent-Orchestrator“**. Der Link steht dezent unter den Einstellungsbereichen, nicht in der Hauptnavigation; der Pfeil rechts daneben klappt die Unterseiten animiert auf (Motion, `OrchestratorSettingsLinks` in `src/components/orchestrator-nav.tsx`). Kopf mit **Aktualisieren** und eine Unter-Navigation mit gleitender Markierung bleiben beim Wechsel stehen (`layout.tsx`); `/einstellungen/orchestrator` leitet auf „Aufbau & Topologie“ um.

- **Aufbau & Topologie** (`/einstellungen/orchestrator/aufbau`):
  - Strukturbaum: Orchestrator → Regeln · Supervisor (Plant: DeepSeek Flash, Schreibt: DeepSeek V4 Pro) → fünf Spezialisten mit allen Werkzeugen als Chips (ändernde markiert) und Recherche (Websuche, Finanzwissen) · lokaler Rückfall (Qwen); reines CSS, ohne neue Abhängigkeit.
  - KI-Status: „KI bereit · DeepSeek Flash · Qwen als Rückfall“ oder die Warnung „Lokal (Qwen) aktiv · DeepSeek …“ mit dem Grund, z. B. „Rate-Limit (HTTP 429)“.
  - Modelle: Modell je Aufgabe aus `/api/ai/status` mit dem Hinweis, dass Qwen bei Ausfällen übernimmt und Namen und Kontonummern pseudonymisiert werden.
  - Kosten: siehe [Kosten](#kosten).
- **Agenten & Prompts** (`…/agenten`): Zuständigkeit, Kurzbeschreibung, Modell je Schritt und Zahl der letzten Läufe; darunter der Prompt-Editor (siehe [Agenten-Prompts](#agenten-prompts-json)).
- **Letzte Läufe** (`…/laeufe`): bis zu 50 Anfragen aus dem Chatverlauf mit Zeit, Agent, Weg, Status (beantwortet, Rückfrage, unklar, Fehler), grober Dauer und den Modellen des Laufs („DeepSeek Flash“, „Lokal (Qwen) (Rückfall)“ mit dem Grund als Tooltip).
  - Darunter stehen dezent die Werkzeugaufrufe des Laufs als kleine Chips, in Reihenfolge: Kurzbeschreibung (z. B. „Kategorisiere Buchung“, „Lege Vertrag an“, „Websuche“, „Wissen nachschlagen“), technischer Werkzeugname und ein Symbol für den Ausgang – erfolgreich, fehlgeschlagen oder bei Änderungen wartet auf Bestätigung, übernommen, verworfen, rückgängig gemacht. Der Ausgang steht für Screenreader auch als Text da, nicht nur als Farbe.
  - Erfasst werden das antwortende Werkzeug (bei kombinierten Fragen jedes Teils), Suchen im lokalen Finanzwissen und im Lexikon, Marktdaten, die Websuche, die freie Antwort des Modells, automatisch Gemerktes und das getippte „Ja“, das eine Änderung übernimmt. Fehler („Dabei ist etwas schiefgegangen“, nicht erreichbare Suche, keine Modellantwort) zählen als fehlgeschlagen. Ältere Antworten ohne diese Liste zeigen ihr eines Werkzeug.
- **Werkzeuge** (`…/werkzeuge`): Tabelle je Agent; Werkzeuge, die Daten ändern, sind markiert und laufen nur nach Bestätigung.
- **Feedback & Regeln** (`…/feedback`): Ort der Feedback-Datei, Zahl der 👍/👎 und Kommentare, die neuesten fünf Einträge und **Herunterladen** (siehe [Feedback-Datei](#feedback-datei-für-copilot)); jede gelernte Regel mit Status, Geltungsbereich, Kommentar, Gold-Eval ohne → mit Regel und den Fällen, die schlechter wurden; **Deaktivieren**, **Aktivieren** (nur nach bestandener Eval) und **Erneut prüfen** (siehe [Regeln aus Feedback](#regeln-aus-feedback)).
- **Aktualisieren** lädt die Daten der offenen Unterseite neu.

Dafür speichert jede Antwort im Chatverlauf zusätzlich die optionalen Felder `via` (Regel, Supervisor, Signal, Modell, Rückfall), `ms` (Dauer), `calls` (höchstens acht Werkzeugaufrufe mit `tool`, `ok` und `summary`, für die Details auch `args` ≤ 200 und `result` ≤ 400 Zeichen; der Ausgang einer Änderung folgt ihrem `status`), `models` (höchstens vier: Anbieter, Modell, Aufgabe, Rückfall mit Grund, Denkmodus) und `prompt` (System-Prompt der Antwort, gekürzt auf 3.000 Zeichen, nur bei den neuesten 20 Nachrichten). Das ist JSON im bestehenden Verlauf, keine Migration. In die Feedback-Datei gehen von den Aufrufen weiter nur `tool`, `ok` und `summary`.

**Dateien:** `src/lib/assistant/orchestrator-info.ts` (Daten), `src/lib/assistant/orchestrator-pages.ts` (Unterseiten), `src/components/orchestrator-admin.tsx` (Shell und Ansichten), `src/components/orchestrator-nav.tsx` (Navigation), `src/app/(dashboard)/einstellungen/orchestrator/` (Layout, Umleitung, fünf Unterseiten).

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

**Datenüberblick** (`appOverview` in `src/lib/assistant/facts.ts`): Bei Fragen zum eigenen Geld bekommt der antwortende Agent zusätzlich einen kompakten Überblick, und der [Supervisor](#supervisor-deepseek-flash-plant-v4-pro-schreibt) bekommt ihn bei jeder Frage: Konten und Summe, dieser Monat mit Budgets, Ausgaben nach Kategorie (dieser und letzter Monat), Jahr bis heute, frei bis zum Gehalt, Abos (Liste und Summe), Anstehendes, Sparziele, Giro-Prognose, Amex, Gehalt, Auffälliges und die letzten 12 Buchungen. Name des Nutzers und IBANs werden vor DeepSeek maskiert; allgemeine Fragen sehen den Überblick in der Antwort nicht.

**Freie Werkzeugwahl:** Die Wahl der Lese-Werkzeuge trifft seit dem 14.11.2026 der [Supervisor](#supervisor-deepseek-flash-plant-v4-pro-schreibt) schon beim Routing. Der frühere eigene Planer (`/api/ai/plan`) entfällt; er hätte einen zweiten V4-Pro-Aufruf gekostet.

**Natürlichere Antworten** (`src/lib/ai/specialists.ts`): Die Antwortregeln sind lockerer – direkt zur Sache, 2–4 Sätze, Zusammenhang erklären, wenn er hilft, den Überblick nutzen und aktuelle Web-Werte mit Stand und Quelle nennen. Die Belegprüfung bleibt: Jede Zahl muss aus Fakten, Werkzeugen oder Quellen stammen.

**Änderungen nur mit Bestätigung:** Daran ändert sich nichts. Anlegen, Ändern, Löschen und Verschieben laufen weiter über Vorschau und „Ja“; der Supervisor führt nur lesende Werkzeuge aus.

## Supervisor (DeepSeek Flash plant, V4 Pro schreibt)

Der Assistent entscheidet bei jeder Anfrage selbst, welche Daten oder Recherchen nötig sind, holt sie und antwortet konkret (`src/lib/ai/supervisor.ts`, Aufgaben „Supervisor“ und „Supervisor-Antwort“). Stand 15.11.2026.

- **Wer ihn bekommt:** jede Nachricht außer Systembefehlen und laufenden Formularen (siehe [Ablauf](#ablauf-und-ki-aufrufe)), auch Änderungen, Rechnen, Korrekturen, Smalltalk, Gedichte, Begriffe und aktuelle Werte. Ein Werkzeug, das die Regeln erkennen, bekommt er als Hinweis; bei einer Korrektur keinen, weil die Regeln nur die neue Nachricht sehen.
- **Was er sieht:** die Nachricht, die letzten acht Nachrichten (Nutzer bis 400, Antworten des Assistenten bereinigt bis 500 Zeichen), die Namen der Sparziele und geplanten Ausgaben und den **Datenüberblick** (`appOverview`, rund 1.500 Zeichen): Konten und Summe, dieser Monat mit Budgets und überzogenen Posten, Ausgaben nach Kategorie (dieser und letzter Monat), Jahr bis heute mit Top-Kategorien, frei bis zum Gehalt, Abos (Liste, Summe), Anstehendes, Sparziele, Giro-Prognose, Amex, Gehalt, Auffälliges und die letzten 12 Buchungen. Im statischen Prompt stehen alle Spezialisten mit ihren Werkzeugen und die Regeln aus Feedback (Wirkung Werkzeugwahl).
- **Was er entscheidet** (JSON, geprüft in `cleanSupervision`):
  - Spezialist und Art (`antwort`, `aktion`, `rueckfrage`; das frühere `werkzeug` zählt als Antwort mit einem Schritt);
  - 0–4 Lese-Schritte mit Teilfrage in der Ich-Form – nur Werkzeuge, die nichts ändern, `knowledge` oder `web`;
  - Begriffe, Erklärungen, aktuelle Werte und Recherche schlägt er im Web nach; ein `knowledge`-Schritt bekommt immer einen `web`-Schritt dazu, und eine Frage nach einem aktuellen Wert (oder „Such im Internet …“) beginnt im Browser immer mit einer Live-Websuche;
  - ein Rechner ohne Betrag wird zum Monatsplan (`budget`), weil er sonst nur nach dem Betrag fragen könnte;
  - eine Rückfrage nur als echte Frage; fragt sie nur nach Preis, Betrag oder Laufzeit („Wie viel soll das Handy kosten?“), wird daraus eine Antwort mit dem passenden Lese-Werkzeug (Monatsplan, Abfrage, Verträge, Gehalt); alles Unklare wird eine geschriebene Antwort.
- **Antwort:** Der Browser führt die Schritte aus (`runWorkers`) und gibt dem Supervisor ihre Rohdaten (`rawData`, bis 3.200 Zeichen) samt Fakten, Datenüberblick, lokalem Wissen (RAG) und Webquellen (Evidenz bis 4.000 Zeichen). Die Fakten sind die des führenden Spezialisten **und** aller, deren Werkzeuge liefen (`contextFacts` in `src/lib/assistant/specialist-context.ts`); wird der Kontext größer als rund 9.000 Zeichen, fallen zuerst Details der helfenden Spezialisten weg, die der Überblick schon zusammenfasst, nie die des führenden. Er schreibt zuerst die Kernaussage, dann kurze Absätze oder eine kurze Liste mit den tragenden Zahlen und einem nächsten Schritt; Quellen mit [1], [2]. V4 Pro ohne Denkmodus, weil die Zahlen schon berechnet sind; nur Steuer-Analysen an Gehalt & Steuern („Warum zahle ich so viel Lohnsteuer?“) denken gründlich. Die Belegprüfung gilt unverändert, je Satz, Listenpunkt und Tabellenzeile (siehe [Formatierung](#formatierung-markdown)). Ohne Modelltext spricht der Befund des ersten Werkzeugs.
- **Gelernt und Feedback:** Allgemeine Antworten ohne eigene Zahlen werden wie bisher lokal gemerkt (Web-Antworten mit „Das hat geholfen“). Eine vom Nutzer bestätigte Antwort zeigt der Chat mit Supervisor nicht mehr direkt an: Sie geht als verlässliche Evidenz an V4 Pro, der sie mit den heutigen Daten neu schreibt (👍/👎 zählen weiter für den gemerkten Eintrag); nur ohne DeepSeek kommt sie wie früher sofort aus dem Gedächtnis. 👍/👎, Kommentare und die Regel-Schleife bleiben.
- **Rückfall:** Ohne DeepSeek, bei einer Pause oder einem unlesbaren Plan routet der Server lokal und meldet `local`; der Chat nutzt dann zwei Minuten lang die früheren festen Wege, und Qwen antwortet.
- **Admin:** Weg „Supervisor“ in „Letzte Läufe“, Modelle „DeepSeek Flash · Supervisor“ und „DeepSeek V4 Pro · Supervisor-Antwort“; im Baum der Supervisor mit „Plant“ und „Schreibt“, dazu Agent und Werkzeugaufrufe je Lauf.

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

**Gemessen am 15.11.2026** (DeepSeek, synthetische Daten, Browser):

| Frage | Schritte | Ergebnis |
| --- | --- | --- |
| „Hallo, wie geht's?“ | keine | natürliche Antwort mit Bezug auf die Woche, 5,9 s |
| „Was ist eine Vorabpauschale?“ | `knowledge` + `web` | Erklärung mit Quelle und Hinweis auf Österreich, 7,5 s |
| „Kann ich mir ein neues Handy leisten?“ | `budget` | „Ja, … aus dem Überschuss …“, Kennzahlen und Kachel, 6 s |
| „Wird mein Konto knapp?“ | `forecast` | Kernaussage, vier Kennzahlen, Kachel mit Sparkline, 7 s |
| „Wie viel netto bekomme ich?“ | `payroll` | 2.780 € netto samt Sonderzahlung, Kachel |
| „Lösch die Buchung vom 3.8. über 249 €“ | Befehl, kein Supervisor | Werkzeug sucht die Buchung, Vorschau und Bestätigung wie bisher |

- Eval: Smoke 24/24, Gold 80/80, Deep 15/15.

## Korrekturen und Gesprächsverlauf

Stand 15.11.2026. Vorher wurde „Nein, das ist für American Express, ich meine mein Raiffeisen-Konto, das im Quartal ca. 36 € kostet“ als neuer Befehl gelesen (Kontoregel-Formular), und der Supervisor sah nur vier Verlaufszeilen.

- **Verlauf:** Der Chat schickt die letzten acht Nachrichten (Nutzer bis 400, Assistent bis 700 Zeichen); Supervisor und V4 Pro bekommen alle acht, der Werkzeug-Prompt eines Spezialisten vier, Qwen im lokalen Rückfall vier (Chat) bzw. zwei (Spezialist). Namen und IBANs werden wie immer vor DeepSeek maskiert.
- **Korrektur erkennen** (`correctsPrevious` in `src/lib/assistant/learning.ts`): „Nein …“, „Doch …“, „Falsch …“, „Stimmt nicht …“, „Ich meine/meinte …“, „Gemeint war …“, „Es geht um …“, „nicht X, sondern Y“, „Das ist doch für …“ – nur direkt nach einer fertigen Antwort, nicht unter einer offenen Vorschau oder Rückfrage (dort gelten „Ja“/„Nein“ wie bisher).
- **Was dann passiert:** Keine Regel und kein neuer Befehl. Die ganze Nachricht geht mit `correction: true` an den Supervisor, der mit V4 Pro plant: Er liest im Verlauf, worum es ging, behält Thema, Zeitraum und Konto bei und tauscht nur, was korrigiert wurde. Eine Aktion plant er dabei nur, wenn die Nachricht selbst etwas ändern will („…, lösch sie“); sonst wird daraus eine Antwort. Die Antwort von V4 Pro bekommt den Verlauf und den Hinweis, dass die Frage die vorige Antwort korrigiert; was noch stimmt, darf sie wiederholen.
- **Fortsetzungen:** Supervisor und Antwort-Regeln sagen: auf dem Gespräch aufbauen, Bezüge („das“, „dort“, „und im Oktober?“) aus dem Verlauf nehmen und nie nach etwas fragen, das dort schon steht. Wird eine Antwort mit 👎 abgelehnt, geht die nächste Nachricht ebenfalls als Korrektur an den Supervisor.
- **Rechnen:** „15 % von 2400“ geht an den Supervisor; der Code rechnet (`arithmetic`) und gibt das Ergebnis als verlässliche Evidenz mit, V4 Pro formuliert. Ohne DeepSeek bleibt es die feste Antwort.
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
  - eine Zeile **Modelle**: „DeepSeek Flash (Supervisor) · DeepSeek V4 Pro (Supervisor-Antwort)“, ein Rückfall mit Grund im Tooltip;
  - **Werkzeuge** als kompakte Zeilen: Status (Häkchen grün, Kreuz rot, für Screenreader „erfolgreich“/„Fehler“), Name und gekürzte Eingabe („Monatsplan · Was bleibt mir diesen Monat?“). Das Ergebnis klappt erst auf Klick auf die Zeile auf; Aufrufe ohne Ergebnis sind keine Schaltfläche;
  - der **Prompt** auf zwei Zeilen gekürzt, ganz (scrollbar) erst mit „Ganzen Prompt zeigen“. Er enthält keine Fakten, nur Stimme, Regeln und Datenregel.
- Die Kacheln einer Antwort klappen mit „Mehr“ auf, damit es nur ein „Details“ gibt.

## Agenten-Prompts (JSON)

Alle System-Prompts der Agenten liegen editierbar in einer JSON-Datei; ohne Datei gelten die Standards im Code (`src/lib/ai/agent-prompts.ts`), die Byte für Byte den bisherigen Prompts entsprechen.

- **Bearbeitbar** (14): Routing des lokalen Modells (`orchestrator`), Planung des Supervisors (`supervisor`, mit den Platzhaltern `{werkzeuge}` und `{rechner}`; fehlt `{werkzeuge}`, hängt die App die Liste an), Antwort schreiben (`synthesis`), Antwortregeln (`answer-rules`) sowie je Agent die Stimme (`voice.<agent>`) und die Hinweise zur Werkzeugwahl (`tools.<agent>`).
- **Immer vom Code angehängt:** Werkzeuglisten, JSON-Felder, die Regel für belegte Zahlen (`grounding`), die Datenregel gegen versteckte Anweisungen und die Regeln aus Feedback – ein Edit kann sie nicht entfernen.
- **Datei:** `config/agent-prompts.json` im Projekt, in Produktion neben der Datenbank, oder `FINANZBLICK_AGENT_PROMPTS` (absoluter Pfad); Format `{ "format": "finanzblick-agent-prompts", "version": 1, "prompts": { "<id>": "…" } }`, höchstens 8.000 Zeichen je Prompt, Rechte 0600, nie im Git. Schreiben atomar und nacheinander; eine beschädigte Datei wird nie überschrieben, der Assistent nutzt dann die Standards (`src/lib/server/agent-prompts-store.ts`).
- **Wirkung:** `/api/ai/assistant` und `/api/ai/answer` lesen die Datei bei jeder Anfrage (neu geparst nur nach einer Änderung) – gespeicherte Prompts gelten ab der nächsten Frage.
- **API:** `GET /api/agent-prompts` (Administrator) listet je Prompt Gruppe, Name, Hinweis, Standard, aktiven Text und `custom`; `PUT` mit `{ id, text }` speichert, `{ id, reset: true }` setzt zurück (Administrator, gleiche Herkunft, Rate-Limit).
- **Editor** unter „Agenten & Prompts“: Liste nach Orchestrator, Supervisor und Agenten (angepasste mit Punkt), Textarea mit Zeichenzähler, **Speichern** und **Auf Standard zurücksetzen**, Statusmeldung „Gespeichert – gilt ab der nächsten Frage“.

## Kosten

Budget-Rahmen rund 5 $ im Monat. Listenpreise von DeepSeek je 1 Mio. Token zur Spitzenzeit (Stand 15.11.2026, nachts die Hälfte; `cloudPrices` in `src/lib/ai/models.ts`):

| Modell | Eingabe aus dem Cache | Eingabe | Ausgabe |
| --- | --- | --- | --- |
| `deepseek-flash` | 0,006 $ | 0,30 $ | 1,20 $ |
| `deepseek-v4-pro` | 0,044 $ | 1,32 $ | 3,96 $ |

- **Pro Frage:** ein Flash-Plan (~4.000 Token Eingabe, großteils aus dem Cache), eine V4-Pro-Antwort (~2.000–4.000 Token Eingabe, 150–250 Ausgabe) und Folgefragen auf Flash. Gemessen am 15.11.2026: ≈ 0,35 Cent; ohne Cache-Treffer ≈ 0,8 Cent. Damit reichen 5 $ für rund 650–1.400 Fragen im Monat.
- **Admin:** „Aufbau & Topologie“ zeigt die Kosten pro Frage (gemessen aus den Zählern seit Serverstart, sonst Richtwert), die Fragen für 5 $ und die Summe je Modell; `/api/ai/status` liefert dafür die Token-Zähler (`usage`). Eine harte Sperre gibt es nicht.

## Regeln aus Feedback

Ein 👎 mit Kommentar wird zum Lernanlass (`src/lib/server/rule-loop.ts`). Die Schleife aktiviert nie blind:

1. **Vage Kommentare** („war schlecht“, „falsch“, „???“, unter 12 Zeichen oder weniger als zwei Inhaltswörter) werden als „Zu vage“ vermerkt, ohne Modellaufruf.
2. **Vorschlag:** DeepSeek V4 Pro leitet aus Frage, Antwort, Agent und Kommentar genau eine allgemeine Regel ab (1–2 Sätze, höchstens 240 Zeichen) samt Bereich (Agent oder alle) und Wirkung (Antwort oder Werkzeugwahl). Betrifft der Kommentar nur Daten des Nutzers („Die Buchung war bei Spar“), antwortet es „keine Regel“. Regeln, die Sicherheitsregeln aufheben, Zahlen erfinden lassen oder Links und Kontonummern enthalten, werden verworfen; eine schon aktive gleiche Regel ebenfalls.
3. **Eval-Pflicht:** Die Gold-Suite (80 Fragen, `src/lib/assistant/gold-eval.ts`) plus 6 Antwortfälle laufen einmal mit den aktiven Regeln und einmal zusätzlich mit der neuen Regel, auf DeepSeek Flash bei Temperatur 0, vier Fälle parallel. Unveränderte Prompts kommen aus dem Cache (`data/ai-cache/rule-eval`), deshalb kostet eine Antwortregel für einen Agenten nur wenige Aufrufe (live: 3–13 s, 7–40 Aufrufe).
4. **Aktiv** wird die Regel nur, wenn die Eval mit ihr gleich gut oder besser ist und kein Sicherheitsfehler hinzukommt; sonst „Abgelehnt“ mit beiden Ergebnissen und den Fällen, die schlechter wurden. Höchstens 12 Regeln sind aktiv.
5. **Im Kontext:** Aktive Regeln hängen am Ende des Antwort-Prompts des betroffenen Agenten (Wirkung Antwort) bzw. des Werkzeug- und Orchestrator-Prompts (Wirkung Werkzeugwahl), mit dem Zusatz, dass sie die Sicherheitsregeln nie aufheben. Der Server liest die Datei nur neu, wenn sie sich geändert hat.

- **Datei:** `data/assistant-rules.json` neben der Feedback-Datei (in Produktion neben der Datenbank, `FINANZBLICK_RULES_FILE`), Rechte 0600, nie im Git. Kommentar, Frage und Antwort sind wie in der Feedback-Datei geschwärzt.
- **Admin:** Einstellungen → „Assistent-Orchestrator“ → **Regeln aus Feedback**: Deaktivieren, wieder Aktivieren (nur nach bestandener Eval) und Erneut prüfen (wartende, fehlgeschlagene, abgelehnte oder unbrauchbare). `GET`/`PATCH /api/assistant-rules`, im Kontomodus nur für den Administrator.
- **Ohne DeepSeek** läuft die Schleife nicht; ist DeepSeek gerade pausiert, wartet die Regel („Wartet auf Prüfung“).
- **Stand 14.11.2026, live:** „Bitte ohne Floskel und ohne Wiederholung“ wurde zu „Beginne Antworten ohne Floskel und vermeide Wiederholungen.“ (85/86 → 85/86, aktiv). „Mir fehlt der Jahresbetrag der Abos“ war im ersten Lauf schlechter (85 → 84, abgelehnt, weil das Modell Jahressummen selbst rechnete und die Belegprüfung den Satz verwarf) und bestand die erneute Prüfung. „war schlecht“ wurde als zu vage erkannt, ein Kommentar zu einer einzelnen Buchung als keine Regel.

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
  - Thin Orchestrator: nur Systembefehle per Regel, jede andere Nachricht (Änderungen, Rechnen, Smalltalk, Begriffe, Abfragen, Rat) an den Supervisor;
  - Rückfall bei Unklarheit.
- `assistant.test.ts`:
  - Smalltalk und kreative Bitten über den Supervisor, ohne DeepSeek per Regel (`local`);
  - Änderungen über den Plan `aktion` beim Spezialisten, ohne Modellaufruf, wenn das Werkzeug keine Details liest;
  - eine Korrektur geht ohne Regel-Hinweis mit Verlauf an den Supervisor auf V4 Pro und wird zur Antwort statt zu einem neuen Befehl;
  - Supervisor beantwortet Rat mit Lese-Schritten statt Rückfrage;
  - ohne Supervisor genau ein Ein-Wort-Aufruf mit Rückfall;
  - eine Änderung geht an den Spezialisten, der nur eigene Werkzeuge sieht.
- `supervisor.test.ts`: acht Nachrichten Verlauf, nur lesende Schritte, höchstens vier, Monatsplan statt Rechner ohne Betrag, Websuche zu jedem Begriff, echte Rückfrage, Antwort statt Rückfrage nach Preis oder Laufzeit, Flash mit Team, Datenüberblick und Regel-Hinweis, nur DeepSeek.
- `speed.test.ts`/`payroll.test.ts`: V4 Pro schreibt jede Analyse und Erklärung, Flash nur Smalltalk ohne Daten; Kontext aller beteiligten Spezialisten mit Größengrenze. `fixed-replies.test.ts`: Datum und Uhrzeit als Systembefehl; `speed.test.ts`: Verlauf und Korrektur-Hinweis in der Antwort; `learning.test.ts`: `correctsPrevious`.
- `answer-view.test.ts`: Kennzahlen mit Tönen, Trend-Farbe je Art der Reihe, Rohdaten für den Supervisor, nur Befehle als feste Antworten; `assistant-answer.test.tsx`: Kennzahlen, Kacheln, Sparkline, Details, Kernaussage und Beträge im Text.
- `cloud.test.ts`: der Name des Nutzers (Konto und `FINANZBLICK_PRIVATE_NAMES`) geht nie an DeepSeek, Händler und Beträge schon.
- `speed.test.ts`: Stimme je Agent, Allgemeinwissen nur im Chat ohne persönliche Daten, `tidyAnswer` mit Markdown, Belegprüfung je Listenpunkt und Tabellenzeile, Streaming Zeile für Zeile, belegter Satzanfang.
- `markdown.test.ts`: Blöcke, Inline-Formatierung, nicht geschlossene Marker, sichere Links, Syntax-Farben; `assistant-answer.test.tsx`: Überschrift, Liste, Tabelle, Code ohne rohe Zeichen, Streaming.
- `payroll.test.ts`: Gehaltswerkzeug und Fakten-Ausschnitte.
- `eval-cases.test.ts`: Eigentümer jeder goldenen Frage; grenzwertige Fragen nie beim falschen Spezialisten.
- `tests/assistant-orchestrator.spec.ts`: Smalltalk, allgemeine Frage ohne persönliche Fakten, Gehaltsfrage mit Rohdaten, Kachel und zugeklappten Details (Prompt und Werkzeuge erst nach dem Aufklappen, Ergebnis per Klick), Kontoprognose mit Live-Status nur aus Orb und Kurztext (keine Werkzeuge, kein Modell), Kennzahlen und Sparkline, Datenüberblick ohne IBAN, nur der Droide und keine Spezialisten-Namen, „Nein, ich meine das Sparkonto“ als Korrektur mit Verlauf an Supervisor und Antwort, kein horizontales Scrollen – bei 390 px dunkel und 1440 px hell (Supervisor-Pläne und Antworten gemockt, Werkzeuge echt).
- `tests/assistant-admin.spec.ts`: Admin-Ansicht nur über die Einstellungen erreichbar, Pfeil klappt die Unterseiten auf, Topologie mit Werkzeugen, Kosten, Prompt speichern und zurücksetzen, Läufe, Werkzeuge, Feedback und Regeln, Umleitung von `/einstellungen/orchestrator`, kein horizontales Scrollen bei 1440 px hell und 390 px dunkel.
- `agent-prompts-store.test.ts`: Speichern, Anwenden und Zurücksetzen eines Prompts, feste Teile bleiben, beschädigte Datei bleibt unverändert, Ort in Produktion.
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
- Lernen und Feedback-Schleife: `web-learning.test.ts` (gespeicherte Antworten, Ablaufdatum, nichts Persönliches oder Sensibles, 👍/👎), `search.test.ts` (Vektordatei überlebt einen Neustart), `follow-ups.test.ts` (Prüfung der Folgefragen, nur DeepSeek, fremde Themen fallen weg), `rule-loop.test.ts` (vage, keine Regel, Duplikat, Aktivierung nur bei gleicher oder besserer Eval, Sicherheitsfehler, Warten, Schalter, Regeln im Prompt), `orchestrator-admin.test.tsx` (Regeln mit Eval und Schalter), `tests/assistant-orchestrator.spec.ts` (Folgefragen von DeepSeek gemockt), `tests/assistant-admin.spec.ts` (Bereich „Regeln aus Feedback“ hell und dunkel).
- Modelle und Rückfall: `src/lib/ai/cloud.test.ts` (Modell je Aufgabe, Denkmodus, Rückfall auf Qwen bei 401/402/429/5xx/Netzwerk mit Pausen, Streaming-Rückfall vor dem ersten Wort, Pseudonymisierung samt geteilter Platzhalter, Token-Zähler, Cache, Status), `orchestrator-admin.test.tsx` (Bereich „Modelle“, Warnung bei Rückfall, Modelle in den Läufen), `assistant-chat-parts.test.tsx` (Modell in der Statuszeile).
- `npm run eval:assistant`: Stufen Smoke, Gold (höchstens 80 Fragen) und Deep (15 Fälle, davon drei für den Supervisor); zeigt je Frage Agent, Werkzeug oder Schritte des Supervisors, Weg (Regel, Supervisor, Signal, Modell, Rückfall), Modell, Zahl der KI-Aufrufe und Dauer. Antwortet der Supervisor mit Schritten, zählt ein erwartetes Werkzeug unter ihnen (`routedTo`). Details: [local-ai.md](local-ai.md#qualitätsprüfung).

## Grenzen

- Der Supervisor kostet 1–2 s, bevor die Arbeit beginnt, auch bei Änderungen; nur Systembefehle bleiben ohne Modell. Der längere Verlauf kostet pro Frage etwas mehr Eingabe-Token. Ohne DeepSeek gilt das lokale Routing mit knappen Signalwörtern; was sie nicht eindeutig zuordnen, entscheidet ein Wort von Qwen oder, im Zweifel, der Chat.
- Der Supervisor plant auf Flash; befolgt er die Planungsregeln nicht (etwa eine Rückfrage nach dem Preis), fängt `cleanSupervision` die bekannten Fälle ab. Fehlt etwas, schreibt V4 Pro trotzdem eine Antwort aus Fakten und Überblick.
- Ein angepasster Prompt gilt sofort, wird aber nicht automatisch gegen die Gold-Eval geprüft; `npm run eval:assistant` nutzt die Standards.
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
