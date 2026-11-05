# Lokale KI (NPU)

Finanzblick kann offene Buchungsprüfungen mit einem lokalen Sprachmodell erledigen. Das Modell läuft auf der Intel-NPU (Core Ultra, „Intel AI Boost“). Es arbeitet vollständig offline: Finanzdaten verlassen den Rechner nicht.

## Komponenten

| Teil | Aufgabe |
| --- | --- |
| OpenVINO Model Server (OVMS) | Stellt `Qwen3-8B-int4-cw-ov` auf der NPU als OpenAI-kompatible API unter `http://127.0.0.1:8000/v3` bereit |
| `AiReviewAssistant` (Browser) | Schickt offene Prüfungen in Achterpaketen an `/api/ai/categorize` und übernimmt nur sichere Antworten |
| `/api/ai/logo` | Sucht das Händlerlogo über Wikidata (Eigenschaft P154) und lädt es von Wikimedia Commons in den privaten `Logo/`-Ordner |
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
   - **Erstattung:** Eine Gutschrift mit genau dem Betrag eines früheren Kaufs bei derselben Marke (höchstens 180 Tage zurück) wird als „Rückerstattungen“ zugeordnet.
   - **Feste Händlerregel:** Die Regel aus `categories.ts` gilt direkt, etwa dm → Drogerie oder G2A → Guthabenkarten. Das Modell darf sie nur verfeinern (Mobilität → Tanken). Die Regel gilt nicht, wenn das Vorzeichen nicht passt, wenn Mobilität oder Tanken unter 15 € liegt oder wenn bestätigte Buchungen des Händlers eine andere Kategorie haben.
   - Alles andere bleibt zur manuellen Prüfung offen und erhält einen Vorschlag.
   - Der Browser-Assistent wendet Historie, Erstattung und Regel auch ohne laufendes Modell an.
6. **PayPal und Klarna:** `providerMerchant` liest den Shop hinter dem Zahlungsdienst aus dem Text, etwa „PAYPAL \*ZALANDO“ → Zalando. Ohne erkennbaren Shop (zum Beispiel „PAYPAL EEA“) bleibt die Buchung offen.
7. **Vorschläge im Prüfdialog:** Für jede offene Prüfung wird ein Vorschlag aus Historie, Regel oder Modell (ab 50 % Sicherheit) in `appState.aiSuggestions` gespeichert. Der Dialog füllt die Kategorie damit vor; ein Klick bestätigt. Bestätigte Buchungen zählen danach als Historie.
8. **Gruppen:** Offene Prüfungen derselben Marke und Richtung (ab zwei) erscheinen als Gruppe. „Alle N übernehmen“ ordnet die ganze Gruppe mit einer Entscheidung zu, „Einzeln prüfen“ zeigt die Buchungen einzeln.
9. Übernommene Antworten werden committet, ohne dass eine Händler- oder Namensregel entsteht. Sie werden nie auf gleichnamige andere Buchungen übertragen. Die Buchung erhält `aiAssigned: true`. Eine manuelle Kategorieänderung entfernt die Markierung.
10. Das Modell antwortet als JSON-Liste. Fehlerhafte Einträge werden einzeln verworfen, und fehlende Antworten werden einzeln nachgefragt.
11. Für neu erkannte Händler wird das Logo gesucht und privat in `Logo/` abgelegt. Der Live-Logo-Sync übernimmt es.
12. Ein Hinweis meldet, wie viele Buchungen zugeordnet wurden und wie viele zur manuellen Prüfung bleiben.

Nie automatisch bearbeitet werden Prüfungen mit Importproblemen, OCR-Hinweisen, fehlendem Betrag oder Datum, Amex-Screenshots und fehlendem POS-Händler. Diese brauchen Daten vom Nutzer.

## Auswertungen

Die Übersicht zeigt den Block „KI-Einblicke“ (`src/lib/insights.ts`), der ohne Modell rechnet:

- **Abos:** mindestens drei monatliche oder zwei jährliche Abbuchungen mit ähnlichem Betrag (±25 %). Beendete Abos fallen weg. Preisänderungen ab 2 % und 0,50 € werden gemeldet.
- **Doppelte Abbuchungen:** gleicher Text und Betrag (ab 5 €) innerhalb von drei Tagen in den letzten 60 Tagen.
- **Budgetprognose:** Hochrechnung der Ausgaben des laufenden Monats.
- **Monatszusammenfassung:** `/api/ai/summary` lässt das Modell einen kurzen Text aus festen Zahlen schreiben. Der Text wird nur verwendet, wenn jede Zahl darin aus den übergebenen Fakten stammt. Sonst erscheint ein regelbasierter Text.

## MCP-Server

Werkzeuge: `ai_status`, `list_categories`, `finance_summary`, `finance_insights` (Abos, Preisänderungen, doppelte Abbuchungen, Prognose), `list_open_reviews`, `search_transactions`, `categorize_open_reviews` (`apply=false` liefert nur Vorschläge), `assign_category`, `find_merchant_logo`.

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

## Lokaler Agent

```powershell
npm run ai:agent -- "Wie viel habe ich im Oktober für Lebensmittel ausgegeben?"
npm run ai:agent            # interaktiv, Ende mit leerer Zeile oder exit
```

Der Agent ändert Daten nur, wenn man es ausdrücklich verlangt.
